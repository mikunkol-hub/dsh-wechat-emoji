// wechat-cdn.mjs —— 微信 CDN 补图（2026-10-25）。
// 本机缓存缺失时，允许用「白名单原消息提供的地址」从腾讯微信 CDN 下载表情/图片，
// 并强制核验原消息摘要（md5）。安全边界：
//   ① 仅接受域名后缀命中白名单的 http(s) 地址（防 SSRF 乱拉）；
//   ② 必须提供 32 位 hex 的 md5 摘要，下载后逐字节核验，不匹配即丢弃；
//   ③ 大小/超时上限，临时文件用完即删。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const DEFAULT_WECHAT_CDN_HOSTS = [
  'weixin.qq.com',
  'wx.qq.com',
  'qpic.cn',        // mmbiz.qpic.cn / shmmsns.qpic.cn / wxapp*.qpic.cn …
  'gtimg.cn',       // 腾讯图片 CDN
  'qq.com',         // 兜底腾讯主域（截图/素材类）
  'qlogo.cn',
  'idqqimg.com'
]

const MD5_RE = /^[a-f0-9]{32}$/i
const URL_RE = /^https?:\/\/[^/\s?#]+/i

export function hostAllowed(hostname, hosts = DEFAULT_WECHAT_CDN_HOSTS) {
  const h = String(hostname ?? '').toLowerCase()
  if (!h) return false
  return hosts.some((suffix) => {
    const s = String(suffix).toLowerCase().replace(/^\./, '')
    return h === s || h.endsWith('.' + s)
  })
}

export function validateCdnRequest({ url, md5, hosts = DEFAULT_WECHAT_CDN_HOSTS }) {
  if (typeof url !== 'string' || !URL_RE.test(url)) throw Object.assign(new Error('CDN_URL_INVALID'), { code: 'CDN_URL_INVALID' })
  let parsed
  try { parsed = new URL(url) } catch { throw Object.assign(new Error('CDN_URL_INVALID'), { code: 'CDN_URL_INVALID' }) }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw Object.assign(new Error('CDN_URL_SCHEME_INVALID'), { code: 'CDN_URL_SCHEME_INVALID' })
  if (!hostAllowed(parsed.hostname, hosts)) throw Object.assign(new Error('CDN_HOST_NOT_ALLOWED'), { code: 'CDN_HOST_NOT_ALLOWED' })
  if (typeof md5 !== 'string' || !MD5_RE.test(md5)) throw Object.assign(new Error('CDN_MD5_REQUIRED'), { code: 'CDN_MD5_REQUIRED' })
  return parsed
}

export async function downloadWechatImage({ url, md5, hosts = DEFAULT_WECHAT_CDN_HOSTS, timeoutMs = 20000, maxBytes = 5 * 1024 * 1024, tmpDir }) {
  const parsed = validateCdnRequest({ url, md5, hosts })
  const dir = tmpDir || path.join(os.tmpdir(), 'dsh-wechat-emoji')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'cdn-' + crypto.randomBytes(8).toString('hex') + '.bin')

  let response
  try {
    response = await fetch(parsed.href, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
  } catch (error) {
    throw Object.assign(new Error('CDN_DOWNLOAD_FAILED: ' + String(error?.name ?? error?.message ?? error).slice(0, 100)), { code: 'CDN_DOWNLOAD_FAILED' })
  }
  try {
    // 重定向后仍须落在白名单域内。
    const finalUrl = new URL(response.url)
    if (!hostAllowed(finalUrl.hostname, hosts)) throw Object.assign(new Error('CDN_REDIRECT_HOST_NOT_ALLOWED'), { code: 'CDN_REDIRECT_HOST_NOT_ALLOWED' })
    if (!response.ok) throw Object.assign(new Error(`CDN_HTTP_${response.status}`), { code: 'CDN_HTTP_' + response.status })
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0) throw Object.assign(new Error('CDN_EMPTY_BODY'), { code: 'CDN_EMPTY_BODY' })
    if (bytes.length > maxBytes) throw Object.assign(new Error('CDN_TOO_LARGE'), { code: 'CDN_TOO_LARGE' })
    const digest = crypto.createHash('md5').update(bytes).digest('hex')
    if (digest !== md5.toLowerCase()) throw Object.assign(new Error('CDN_MD5_MISMATCH'), { code: 'CDN_MD5_MISMATCH' })
    fs.writeFileSync(file, bytes, { mode: 0o600 })
    return { path: file, bytes: bytes.length }
  } catch (error) {
    // 失败时清理残留（成功文件由调用方分析完后删除）。
    try { if (fs.existsSync(file)) fs.unlinkSync(file) } catch {}
    throw error
  }
}

export function cleanupDownloaded(file) {
  try { if (file && fs.existsSync(file)) fs.unlinkSync(file) } catch {}
}
