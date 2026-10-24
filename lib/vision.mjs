// 微信表情包 / 聊天截图 → 情绪与含义分析（核心逻辑，不依赖 DSH，可单独测试）
// 实现：调用智谱 GLM-4V-Flash（OpenAI 兼容接口），要求模型输出严格 JSON。
// 格式支持：jpg/jpeg/png/apng/webp/gif/bmp/tiff/ico/avif/heic（可解码的都用 ffmpeg 统一转 PNG 首帧）；
//           微信自有格式 wxgf 无法直接解码，会给出明确提示。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const DEFAULT_BASE = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
const DEFAULT_MODEL = 'glm-4v-flash'
const MAX_TOKENS = 1024 // glm-4v-flash 上限，超了会 400
const MAX_BYTES = 5 * 1024 * 1024
const MAX_DIM = 2000 // 超长边转码时缩小，兼顾清晰度与体积

/** 从文本里抠出第一个 JSON 对象（模型偶尔会带 ```json 或前后废话）。 */
export function extractJson(text) {
  const s = String(text ?? '')
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fence ? fence[1] : s
  const start = body.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < body.length; i += 1) {
    const c = body[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

/** 按文件头识别格式（微信缓存/附件常常没有扩展名，扩展名不可靠）。 */
export function sniffKind(buf) {
  if (!buf || buf.length < 12) return null
  const head = (n) => buf.subarray(0, n).toString('latin1')
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'jpeg', mime: 'image/jpeg' }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    // APNG：PNG 里含 acTL 块，按 PNG 处理（ffmpeg 取首帧）
    return { kind: 'png', mime: 'image/png', animated: buf.includes(Buffer.from('acTL')) }
  }
  if (head(4) === 'GIF8') return { kind: 'gif', mime: 'image/gif', animated: true }
  if (head(4) === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { kind: 'webp', mime: 'image/webp', animated: buf.includes(Buffer.from('ANIM')) }
  }
  if (head(2) === 'BM') return { kind: 'bmp', mime: 'image/bmp' }
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)) return { kind: 'tiff', mime: 'image/tiff' }
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return { kind: 'ico', mime: 'image/x-icon' }
  if (buf.subarray(4, 12).toString('latin1').startsWith('ftyp')) {
    const brand = buf.subarray(8, 12).toString('latin1')
    if (brand.startsWith('avif') || brand.startsWith('avis')) return { kind: 'avif', mime: 'image/avif' }
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return { kind: 'heic', mime: 'image/heic' }
  }
  if (head(4).toLowerCase() === 'wxgf') return { kind: 'wxgf', mime: 'application/x-wxgf', weixin: true }
  return null
}

/** 扩展名 → 可能的格式名（仅在文件头认不出时用于报错）。 */
function extLabel(ext) {
  return ext ? ext.replace(/^\./, '').toUpperCase() : '未知'
}

/** 找 ffmpeg：显式配置 → 环境变量 FFMPEG → bili-whale 自带的 → PATH。 */
function findFfmpeg(explicit) {
  const cands = [explicit, process.env.FFMPEG, path.join(os.homedir(), '.dsh', 'bili-whale', 'bin', 'ffmpeg.exe')]
  for (const c of cands) if (c && fs.existsSync(c)) return c
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8', windowsHide: true })
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim().split(/\r?\n/)[0].trim()
  return null
}

/** 用 ffmpeg 统一转成 PNG（动图/多帧取第一帧，超长边缩放）。 */
function toPng(src, ffmpeg, { timeoutMs = 30000 } = {}) {  const out = path.join(os.tmpdir(), `wechat-emoji-${process.pid}-${Date.now()}.png`)
  const r = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', src,
    '-frames:v', '1',
    '-vf', `scale='min(${MAX_DIM},iw)':-2`,
    '-pix_fmt', 'rgb24',
    out
  ], { windowsHide: true, timeout: timeoutMs })
  if (r.error || r.status !== 0 || !fs.existsSync(out)) {
    try { fs.rmSync(out, { force: true }) } catch {}
    return null
  }
  const buf = fs.readFileSync(out)
  fs.rmSync(out, { force: true })
  return buf
}

/**
 * 微信自绘表情 .wxgf = 'wxgf' 魔数 + HEVC 裸流（微信自绘动图）。
 * 用 ffmpeg 解码 HEVC 抽帧（最多 24 帧、384 缩放），取首/中/末三帧横向拼接，
 * 输出三联帧 PNG——与 WeChatAgent scripts/wechat_sticker.py 的 decode_wxgf 同款。
 */
export function wxgfToPng(buf, ffmpeg, { timeoutMs = 15000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-emoji-wxgf-'))
  try {
    const hevc = path.join(dir, 'input.hevc')
    fs.writeFileSync(hevc, buf.subarray(4))
    const r1 = spawnSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
      '-f', 'hevc', '-i', hevc,
      '-frames:v', '24',
      '-vf', 'scale=384:384:force_original_aspect_ratio=decrease',
      '-vsync', '0',
      path.join(dir, 'frame-%02d.png')
    ], { windowsHide: true, timeout: timeoutMs })
    const frames = fs.readdirSync(dir).filter((n) => /^frame-\d+\.png$/.test(n)).sort()
    if (r1.error || r1.status !== 0 || frames.length < 1) return null
    const picks = [...new Set([frames[0], frames[Math.floor(frames.length / 2)], frames[frames.length - 1]])]
    if (picks.length === 1) return fs.readFileSync(path.join(dir, picks[0]))
    const out = path.join(dir, 'sheet.png')
    const inputs = picks.flatMap((p) => ['-i', path.join(dir, p)])
    const r2 = spawnSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      ...inputs,
      '-filter_complex', `hstack=inputs=${picks.length}`,
      out
    ], { windowsHide: true, timeout: timeoutMs })
    if (r2.error || r2.status !== 0 || !fs.existsSync(out)) return null
    return fs.readFileSync(out)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** 找 sharp（ffmpeg 解不了的格式，如动态 WebP / AVIF）。装在独立目录，避免污染插件依赖。 */
function loadSharp(explicitDir) {
  const dirs = [explicitDir, process.env.WECHAT_EMOJI_SHARP_DIR,
    path.join(os.homedir(), '.dsh', 'wechat-emoji-deps')].filter(Boolean)
  for (const dir of dirs) {
    if (!fs.existsSync(path.join(dir, 'package.json'))) continue
    try {
      const require = createRequire(path.join(dir, 'package.json'))
      return require('sharp')
    } catch { /* 换下一个 */ }
  }
  return null
}

/** sharp 兜底：首帧 PNG，超长边缩放，最多 40MP。 */
async function sharpToPng(sharp, src) {
  return sharp(src, { pages: 1, limitInputPixels: 40000000 })
    .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer()
}

/** 本地图片 → data URI；任何可解码格式都能处理（ffmpeg 优先，sharp 兜底）。 */
async function localImageToDataUrl(abs, opts) {
  const buf = fs.readFileSync(abs)
  const ext = path.extname(abs).toLowerCase()
  const info = sniffKind(buf)

  if (info?.kind === 'wxgf' || ext === '.wxgf') {
    // 微信自绘表情：'wxgf' 魔数 + HEVC 裸流 → ffmpeg 抽帧三联图。
    const ffmpeg = findFfmpeg(opts.ffmpegPath)
    if (!ffmpeg) throw new Error('微信自绘表情（.wxgf）需要 ffmpeg 解码（HEVC 动图），但本机没找到 ffmpeg')
    const png = wxgfToPng(buf, ffmpeg, { timeoutMs: opts.timeoutMs })
    if (!png) throw new Error('微信自绘表情（.wxgf）解码失败（HEVC 抽帧不成功，文件可能损坏）')
    if (png.length > MAX_BYTES) throw new Error(`微信自绘表情转码后仍超过 5MB（${(png.length / 1048576).toFixed(1)}MB）`)
    return `data:image/png;base64,${png.toString('base64')}`
  }

  const mimeByExt = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.ico': 'image/x-icon', '.avif': 'image/avif', '.heic': 'image/heic' }
  const mime = info?.mime ?? mimeByExt[ext] ?? null
  if (!mime) throw new Error(`无法识别的图片格式（扩展名 ${extLabel(ext)}，文件头也不是已知图片）`)

  // 已是 GLM 直接支持的静态格式，且体积合格 → 原样发送
  const directOk = (info?.kind === 'jpeg' || info?.kind === 'png') && !info?.animated && buf.length <= MAX_BYTES
  if (directOk) return `data:${mime};base64,${buf.toString('base64')}`

  // 其余情况（动图、bmp/tiff/ico/avif/heic、超大图）：ffmpeg 优先，sharp 兜底
  const ffmpeg = findFfmpeg(opts.ffmpegPath)
  let png = ffmpeg ? toPng(abs, ffmpeg, { timeoutMs: opts.timeoutMs }) : null
  if (!png) {
    const sharp = loadSharp(opts.sharpDir)
    if (sharp) {
      try { png = await sharpToPng(sharp, abs) } catch { png = null }
    }
  }
  if (!png) {
    if (info?.kind === 'jpeg' || info?.kind === 'png') {
      throw new Error(`图片 ${(buf.length / 1048576).toFixed(1)}MB 超过 5MB 上限，自动转码也失败`)
    }
    throw new Error(`格式 ${(info?.kind ?? extLabel(ext)).toUpperCase()} 无法解码（ffmpeg 与 sharp 都不支持或文件损坏）`)
  }
  if (png.length > MAX_BYTES) throw new Error(`转码后仍超过 5MB（${(png.length / 1048576).toFixed(1)}MB），请先裁剪`)
  return `data:image/png;base64,${png.toString('base64')}`
}

/**
 * 分析一张表情包/图片（支持微信常见全部格式）。
 * @param {object} opts
 * @param {string} opts.image 本地路径或 http(s) URL
 * @param {string} [opts.hint] 聊天上下文（消息文字）
 * @param {string} opts.apiKey 智谱 API Key
 * @param {string} [opts.model]
 * @param {string} [opts.baseUrl]
 * @param {string} [opts.ffmpegPath]
 * @param {number} [opts.timeoutMs]
 */
export async function analyzeEmoji(opts = {}) {
  const { image, hint = '', apiKey } = opts
  if (!image) throw new Error('缺少 image：给本地图片路径或 http(s) URL')
  if (!apiKey) throw new Error('缺少 apiKey：在插件配置里填智谱 API Key')

  let imageUrl = ''
  if (/^https?:\/\//i.test(image)) {
    imageUrl = image
  } else {
    const abs = path.resolve(image)
    if (!fs.existsSync(abs)) throw new Error(`图片不存在：${abs}`)
    imageUrl = await localImageToDataUrl(abs, opts)
  }

  const prompt = [
    '你在帮一个 QQ/微信聊天 agent 理解对方发来的表情包或图片。',
    hint ? `这条消息的上下文：「${String(hint).slice(0, 300)}」` : '',
    '请只输出一个 JSON 对象（不要 markdown 代码块、不要多余文字），字段：',
    '{',
    '  "sentiment": "情绪类别，从 开心/生气/难过/无语/害羞/嘲讽/震惊/亲昵/期待/委屈/敷衍/中性 里选一个",',
    '  "intensity": 0-100 的整数，表示情绪强度,',
    '  "meaning": "这张表情包在当前聊天里想表达的意思，1-2 句",',
    '  "replyHint": "建议怎么回应（语气+一句话示例）",',
    '  "description": "画面/文字内容的一句话描述（含图上的字）"',
    '}'
  ].filter(Boolean).join('\n')

  const body = {
    model: opts.model || DEFAULT_MODEL,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageUrl } },
        { type: 'text', text: prompt }
      ]
    }],
    temperature: 0.3,
    max_tokens: MAX_TOKENS
  }

  const res = await fetch(opts.baseUrl || DEFAULT_BASE, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs || 120000)
  })
  const text = await res.text()
  if (!res.ok) {
    let detail = text
    try { detail = JSON.parse(text)?.error?.message ?? text } catch {}
    throw new Error(`智谱接口 HTTP ${res.status}：${String(detail).slice(0, 300)}`)
  }
  const json = JSON.parse(text)
  const content = json?.choices?.[0]?.message?.content ?? ''
  const parsed = extractJson(content)
  if (!parsed) return { ok: true, raw: content, sentiment: '中性', intensity: 50, meaning: '', replyHint: '', description: '' }

  const out = {
    ok: true,
    sentiment: String(parsed.sentiment ?? '中性'),
    intensity: Math.max(0, Math.min(100, Number(parsed.intensity) || 50)),
    meaning: String(parsed.meaning ?? ''),
    replyHint: String(parsed.replyHint ?? ''),
    description: String(parsed.description ?? '')
  }
  out.message = `情绪：${out.sentiment}（强度 ${out.intensity}/100）\n含义：${out.meaning}\n画面：${out.description}\n建议回应：${out.replyHint}`
  return out
}
