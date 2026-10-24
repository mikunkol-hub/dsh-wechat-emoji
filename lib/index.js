// dsh-wechat-emoji：让 agent 看懂微信/QQ 表情包与聊天截图，并判断对方情绪。
// 暴露一个模型侧工具 wechat_emoji_analyze（GLM-4V-Flash 视觉分析 → 结构化情绪）。

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeEmoji } from './vision.mjs'
import { downloadWechatImage, cleanupDownloaded, applyLegacyMapping, DEFAULT_WECHAT_CDN_HOSTS, DEFAULT_LEGACY_HOST_MAP } from './wechat-cdn.mjs'

export const name = 'dsh-wechat-emoji'

/** 需要 tools 服务注册工具；webServer 支撑设置页里快捷保存 API Key。 */
export const inject = ['tools', 'webServer']

// ── 配置防篡改：关键项内置安全基线，外部改动会在插件启动时自动纠正 ──────────
const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PATCH_FILE = path.join(PLUGIN_DIR, 'cordis.patch.yml')
const BASELINE_PATCH_TEXT = `# dsh-wechat-emoji —— DSH bundle patch（基线版，关键配置受插件内置防护，请勿直接修改）
# 把插件挂进 profile 的配置树（bundle 层）。安装：link 依赖 + node_modules junction + bundles 条目。
- insert:
    - id: dsh-wechat-emoji
      name: dsh-wechat-emoji
      config:
        # 智谱 API Key（GLM-4V-Flash 免费模型）：
        #   · 在此填你的 Key，或留空、改用环境变量 ZHIPU_API_KEY
        #   · 获取：https://open.bigmodel.cn/ → 注册 → API 密钥（新用户送免费额度）
        #   · ⚠️ 别把自己的 Key 提交到公开仓库
        apiKey: ""
        model: glm-4v-flash
        timeoutMs: 120000
        # 可选：GIF/非常见格式转码用的 ffmpeg（不填则依次找环境变量 FFMPEG、~/.dsh/bili-whale/bin/ffmpeg.exe、PATH）
        ffmpegPath: ""
`
function guardPatchFile() {
  try {
    const text = fs.readFileSync(PATCH_FILE, 'utf8')
    const checks = [
      'apiKey: ""',
      'model: glm-4v-flash',
      'timeoutMs: 120000',
      'ffmpegPath: ""',
      'id: dsh-wechat-emoji'
    ]
    const missing = checks.filter((c) => !text.includes(c))
    if (!missing.length) return false
    console.log(`[dsh-wechat-emoji] 检测到 cordis.patch.yml 被修改（缺失 ${missing.length} 项关键配置），自动恢复基线。`)
    const bak = PATCH_FILE + '.tampered.bak'
    if (!fs.existsSync(bak)) fs.copyFileSync(PATCH_FILE, bak)
    fs.writeFileSync(PATCH_FILE, BASELINE_PATCH_TEXT, 'utf8')
    return true
  } catch { return false }
}

/**
 * 配置面板（DSH 设置页 → 插件 → dsh-wechat-emoji → 配置）：
 * 声明 Config 后 DSH 自动渲染表单并走 Loader 正常保存/热重载路径。
 * apiKey 用 .role('secret') → 设置页里是掩码输入框。
 */
export const Config = z.object({
  apiKey: z.string()
    .description('智谱 API Key（GLM-4V-Flash，免费）。留空则读环境变量 ZHIPU_API_KEY；获取：open.bigmodel.cn → API 密钥。')
    .role('secret')
    .default(''),
  model: z.string().description('视觉模型名').default('glm-4v-flash'),
  baseUrl: z.string().description('兼容 OpenAI 格式的接口地址').default('https://open.bigmodel.cn/api/paas/v4/chat/completions'),
  timeoutMs: z.number().description('单次请求超时（毫秒）').min(1000).max(600000).default(120000),
  ffmpegPath: z.string().description('可选：ffmpeg 路径（动图取首帧/非常见格式转码用），留空自动找').default(''),
  allowWechatCdnDownload: z.boolean()
    .description('允许从腾讯微信 CDN 下载本机缓存缺失的表情包（仅接受白名单原消息提供的地址，并强制核验原消息 md5 摘要）。')
    .default(true),
  wechatCdnHosts: z.array(z.string())
    .description('微信 CDN 下载的域名后缀白名单（默认覆盖 weixin.qq.com / qpic.cn / gtimg.cn / qq.com 等腾讯域）。')
    .default([]),
  wechatCdnLegacyHosts: z.dict(z.string())
    .description('旧版腾讯域名 → 兼容域名映射（如 {"mmsns.qpic.cn":"shmmsns.qpic.cn"}）；下载旧地址时先映射，并强制 HTTPS、核验 md5 摘要。')
    .default({})
})

export function apply(ctx, config = {}) {
  guardPatchFile()
  // 运行时兜底：配置缺失/被改时用内置安全值；apiKey 若被写进配置文件则忽略（以面板文件/环境变量为准）。
  const effectiveConfig = typeof config === 'object' && config ? config : {}
  const apiKey = String(process.env.ZHIPU_API_KEY ?? '').trim() // 面板文件优先，由 effectiveApiKey 合并
  const model = String(effectiveConfig.model ?? 'glm-4v-flash')
  const baseUrl = String(effectiveConfig.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4/chat/completions')
  const ffmpegPath = effectiveConfig.ffmpegPath ? String(effectiveConfig.ffmpegPath) : undefined
  const timeoutMs = Number(effectiveConfig.timeoutMs ?? 120000)
  const allowWechatCdnDownload = effectiveConfig.allowWechatCdnDownload !== false
  const cdnHosts = Array.isArray(effectiveConfig.wechatCdnHosts) && effectiveConfig.wechatCdnHosts.length
    ? effectiveConfig.wechatCdnHosts.map(String).map((s) => s.toLowerCase())
    : DEFAULT_WECHAT_CDN_HOSTS
  const cdnLegacyMap = (() => {
    const map = { ...DEFAULT_LEGACY_HOST_MAP }
    if (effectiveConfig.wechatCdnLegacyHosts && typeof effectiveConfig.wechatCdnLegacyHosts === 'object' && !Array.isArray(effectiveConfig.wechatCdnLegacyHosts)) {
      for (const [k, v] of Object.entries(effectiveConfig.wechatCdnLegacyHosts)) if (typeof v === 'string' && v) map[String(k)] = v
    }
    return map
  })()

  // 设置页面板保存的 Key 存独立文件；优先级：面板文件 > 环境变量（配置文件里的 apiKey 已被防篡改忽略）。
  const keyFile = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-wechat-emoji-key.json')
  const readKeyFile = () => {
    try {
      const v = JSON.parse(fs.readFileSync(keyFile, 'utf8')).apiKey
      return typeof v === 'string' ? v.trim() : ''
    } catch { return '' }
  }
  const writeKeyFile = (value) => {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true })
    const temp = keyFile + '.tmp'
    fs.writeFileSync(temp, JSON.stringify({ apiKey: value }), { mode: 0o600 })
    fs.renameSync(temp, keyFile)
  }
  const effectiveApiKey = () => readKeyFile() || apiKey

  ctx.tools.register(defineTool({
    name: 'wechat_emoji_analyze',
    description:
      '识别聊天里的表情包/图片并判断对方情绪。输入本地图片路径（支持无扩展名的微信缓存文件）或 http(s) URL，' +
      '支持微信全部常见图片格式：jpg/jpeg/png/apng/webp(含动态)/gif(取首帧)/bmp/tiff/ico/avif/heic；' +
      '微信自绘表情 .wxgf（wxgf 头 + HEVC 动图）会自动解码为首/中/末三帧拼接图再分析。' +
      '返回：情绪类别与强度（0-100）、这张表情包在当前语境下的含义、建议怎么回应、画面内容描述。' +
      '适用场景：微信/QQ 收到表情包、梗图、聊天截图，需要判断对方情绪（开心/生气/无语/嘲讽/害羞……）或回什么时使用。',
    parameters: {
      image: {
        type: 'string',
        description: '本地图片绝对路径，或 http(s) 图片 URL。支持 jpg/jpeg/png/apng/webp/gif/bmp/tif/tiff/ico/avif/heic 及微信自绘表情 .wxgf；无扩展名时按文件头识别。'
      },
      hint: {
        type: 'string',
        description: '可选：这条消息的文字内容或前后语境（例如「今天又加班」），能显著提高情绪判断准确率。'
      },
      cdnUrl: {
        type: 'string',
        description: '可选：本机缓存缺失时，白名单原消息提供的微信 CDN 下载地址（仅接受腾讯微信域名的 http(s) 地址）。必须与 cdnMd5 一起提供。'
      },
      cdnMd5: {
        type: 'string',
        description: '可选：原消息的 md5 摘要（32 位十六进制）。提供 cdnUrl 时必填，下载后逐字节核验，不匹配会拒绝。'
      }
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String(value?.message ?? value?.error ?? '') }]
    },
    async execute(args) {
      try {
        let image = args?.image
        let downloaded = null
        // 本机缓存缺失时，用白名单原消息提供的 CDN 地址下载（强制核验 md5）。
        const localMissing = typeof image === 'string' && image && !/^https?:\/\//i.test(image) && !fs.existsSync(image)
        if (localMissing && allowWechatCdnDownload && typeof args?.cdnUrl === 'string' && args.cdnUrl) {
          downloaded = await downloadWechatImage({
            url: args.cdnUrl,
            md5: args.cdnMd5,
            hosts: cdnHosts,
            legacyMap: cdnLegacyMap,
            timeoutMs: Math.min(timeoutMs, 60000)
          })
          image = downloaded.path
        }
        try {
          return await analyzeEmoji({
            image,
            hint: args?.hint,
            apiKey: effectiveApiKey(),
            model,
            baseUrl,
            ffmpegPath,
            timeoutMs
          })
        } finally {
          if (downloaded) cleanupDownloaded(downloaded.path)
        }
      } catch (error) {
        const message = `表情包分析失败：${error?.message ?? error}`
        return { ok: false, error: message, message }
      }
    }
  }))

  // ── 设置页面板的后端：/api/dsh-wechat-emoji/settings（只回环）──────────────
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 64 * 1024) { reject(new Error('PAYLOAD_TOO_LARGE')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(new Error('BAD_JSON')) }
    })
    req.on('error', reject)
  })
  const loopbackOnly = (req) => {
    const a = String(req.socket?.remoteAddress ?? '')
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
  }
  const disposeRoute = ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-wechat-emoji/settings',
    handler: async (req, res) => {
      if (!loopbackOnly(req)) return json(res, 403, { ok: false, error: 'LOOPBACK_ONLY' })
      if (req.method === 'GET') {
        const key = readKeyFile()
        return json(res, 200, { ok: true, hasKey: key.length > 0, tail: key ? '…' + key.slice(-4) : '' })
      }
      if (req.method === 'POST') {
        let body
        try { body = await readBody(req) } catch { return json(res, 400, { ok: false, error: 'BAD_REQUEST' }) }
        if (!body || typeof body.apiKey !== 'string' || body.apiKey.length > 200) return json(res, 400, { ok: false, error: 'INVALID_API_KEY' })
        try {
          writeKeyFile(body.apiKey.trim())
          return json(res, 200, { ok: true })
        } catch (error) {
          return json(res, 500, { ok: false, error: 'SAVE_FAILED', detail: String(error?.message ?? error).slice(0, 200) })
        }
      }
      return json(res, 404, { ok: false, error: 'NOT_FOUND' })
    }
  })
  ctx.effect(() => disposeRoute)
}
