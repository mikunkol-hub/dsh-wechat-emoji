// dsh-wechat-emoji：让 agent 看懂微信/QQ 表情包与聊天截图，并判断对方情绪。
// 暴露一个模型侧工具 wechat_emoji_analyze（GLM-4V-Flash 视觉分析 → 结构化情绪）。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { analyzeEmoji } from './vision.mjs'

export const name = 'dsh-wechat-emoji'

/** 需要 tools 服务来注册工具。 */
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const apiKey = String(config.apiKey ?? process.env.ZHIPU_API_KEY ?? '').trim()
  const model = String(config.model ?? 'glm-4v-flash')
  const baseUrl = String(config.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4/chat/completions')
  const ffmpegPath = config.ffmpegPath ? String(config.ffmpegPath) : undefined
  const timeoutMs = Number(config.timeoutMs ?? 120000)

  ctx.tools.register(defineTool({
    name: 'wechat_emoji_analyze',
    description:
      '识别聊天里的表情包/图片并判断对方情绪。输入本地图片路径（支持无扩展名的微信缓存文件）或 http(s) URL，' +
      '支持微信全部常见图片格式：jpg/jpeg/png/apng/webp(含动态)/gif(取首帧)/bmp/tiff/ico/avif/heic；' +
      '微信自有格式 .wxgf 无法直接解码，会返回明确提示。' +
      '返回：情绪类别与强度（0-100）、这张表情包在当前语境下的含义、建议怎么回应、画面内容描述。' +
      '适用场景：微信/QQ 收到表情包、梗图、聊天截图，需要判断对方情绪（开心/生气/无语/嘲讽/害羞……）或回什么时使用。',
    parameters: {
      image: {
        type: 'string',
        description: '本地图片绝对路径，或 http(s) 图片 URL。支持 jpg/jpeg/png/apng/webp/gif/bmp/tif/tiff/ico/avif/heic；无扩展名时按文件头识别。'
      },
      hint: {
        type: 'string',
        description: '可选：这条消息的文字内容或前后语境（例如「今天又加班」），能显著提高情绪判断准确率。'
      }
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String(value?.message ?? value?.error ?? '') }]
    },
    async execute(args) {
      try {
        return await analyzeEmoji({
          image: args?.image,
          hint: args?.hint,
          apiKey,
          model,
          baseUrl,
          ffmpegPath,
          timeoutMs
        })
      } catch (error) {
        const message = `表情包分析失败：${error?.message ?? error}`
        return { ok: false, error: message, message }
      }
    }
  }))
}
