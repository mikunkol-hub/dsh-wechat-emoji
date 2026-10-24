# dsh-wechat-emoji

让 DSH 的 agent **看懂聊天里的表情包 / 梗图 / 聊天截图，并判断对方情绪**。

- 注册一个模型侧工具 `wechat_emoji_analyze`，底层调用智谱 **GLM-4V-Flash**（免费视觉大模型）；
- 自带**设置页面板**：装完在 DeepSeek 设置页里就能填 API Key，不用碰文件。

## 能力

| 输入 | 说明 |
|---|---|
| `image` | 本地图片路径（支持**无扩展名**的微信缓存文件）或 http(s) URL；jpg/jpeg/png/apng/webp(含动图)/gif(取首帧)/bmp/tiff/ico/avif/heic |
| `hint` | 可选。这条消息的文字/上下文（如「今天又加班」），显著提高情绪判断准确率 |
| `cdnUrl` | 可选。**本机缓存缺失时**，白名单原消息提供的微信 CDN 下载地址（仅接受腾讯微信域名的 http(s) 地址） |
| `cdnMd5` | 可选。原消息的 md5 摘要（32 位十六进制）；提供 `cdnUrl` 时必填，下载后逐字节核验，不匹配即拒绝 |

输出（结构化 JSON）：

| 字段 | 说明 |
|---|---|
| `sentiment` | 情绪类别：开心/生气/难过/无语/害羞/嘲讽/震惊/亲昵/期待/委屈/敷衍/中性 |
| `intensity` | 情绪强度 0–100 |
| `meaning` | 这张表情包在当前语境下想表达什么 |
| `replyHint` | 建议怎么回应（语气 + 一句话示例） |
| `description` | 画面内容（含图上的文字） |

微信自绘表情 `.wxgf`（`wxgf` 魔改 + HEVC 动图）会自动用 ffmpeg 解码为首/中/末三帧拼接图再分析，无需另存为。

## 快速开始

### 0) 准备

- 一个 DSH profile
- 智谱 API Key：[open.bigmodel.cn](https://open.bigmodel.cn/) 注册后在「API 密钥」创建（GLM-4V-Flash 免费，新用户送额度）

### 1) 安装

**方式 A：npm 安装（推荐，已发布到 npm）**

```bash
dsh-wechat-emoji
```

**方式 B：仅源码安装（GitHub）**

```bash
dsh plugin --profile web add github:mikunkol-hub/dsh-wechat-emoji
```

**方式 C：手动 link（开发/离线场景）**

```powershell
# 把插件目录链接进 profile 的 node_modules（junction）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-wechat-emoji" `
  -Target "<插件源码目录>"
```

然后在 profile 的 `package.json` 里加两处（`pnpm install` 一遍以登记依赖）：

```jsonc
{
  "dependencies": {
    "dsh-wechat-emoji": "link:<插件源码目录>"
  },
  "dsh": { "profile": { "bundles": [ "dsh-wechat-emoji" ] } }
}
```

> ⚠️ **必须声明 `peerDependencies`**：插件里 `import { defineTool } from '@deepseek-ai/dsh-tools'` 时，
> `package.json` 必须写 `"peerDependencies": { "@deepseek-ai/dsh-tools": "*" }`。
> DSH 加载 **link 安装**的插件时，只有 manifest 的 `dependencies` / `peerDependencies` 里列出的宿主包才会被解析；
> 不声明的话 import 失败但不报错——插件静默停在 `fiberPhase: null`，工具永远不会出现。
> （本插件已正确声明，这一条是给开发者参照的。）

### 2) 配置 API Key

**方式 A：设置页面板（推荐，最省事）**

1. DeepSeek 设置页 → 插件（Plugins）→ 点进 **dsh-wechat-emoji**；
2. 详情页里有一个「智谱 API Key」设置区：粘贴 Key → **保存**；
3. 保存即热重载生效，不用重启、不用改文件。已设置的 Key 只显示末 4 位。

**方式 B：环境变量**

设 `ZHIPU_API_KEY` 后重启 DSH（面板里留空时自动读这个）。

**方式 C：配置文件（手动）**

在 `cordis.patch.yml` 的 `apiKey` 填你的 Key，保存即触发 profile 热重载。

### 3) 验证

- 面板保存后可以直接在会话里让 agent 分析一张表情包；
- 或看工具列表里是否出现 `wechat_emoji_analyze`。

## 配置

| 字段 | 默认 | 面板可改 | 说明 |
|---|---|---|---|
| `apiKey` | `""` | ✅（掩码输入） | 智谱 API Key；留空则读环境变量 `ZHIPU_API_KEY` |
| `model` | `glm-4v-flash` | ✅ | 视觉模型名 |
| `baseUrl` | 智谱 v4 chat/completions | ✅ | 兼容 OpenAI 格式的地址 |
| `timeoutMs` | `120000` | ✅ | 单次请求超时 |
| `ffmpegPath` | 自动找 | ✅ | 转码用；不填依次找 `FFMPEG` 环境变量、`~/.dsh/bili-whale/bin/ffmpeg.exe`、PATH |
| `allowWechatCdnDownload` | `true` | ✅ | 允许本机缓存缺失时从微信 CDN 补图（域名白名单 + md5 核验，见下） |
| `wechatCdnHosts` | 微信域默认列表 | ✅ | CDN 域名后缀白名单；默认覆盖 `weixin.qq.com` / `qpic.cn` / `gtimg.cn` / `qq.com` 等腾讯域 |
| `wechatCdnLegacyHosts` | `{"mmsns.qpic.cn":"shmmsns.qpic.cn"}` | ✅ | 旧版腾讯域名 → 兼容域名映射；下载旧地址时先映射，并强制 HTTPS、核验 md5 |

> ffmpeg 只在「动图取首帧 / bmp·tiff·ico·avif·heic 等格式转码」时需要；只有 jpg/png 图片的场景没有它也能用。

### 配置防篡改

插件内置关键配置的安全基线，防止配置被意外/恶意修改导致功能失效或 Key 泄露：

- **API Key 只认设置面板与环境变量**：即使有人在 `cordis.patch.yml` 里填了 `apiKey`，插件也会忽略该值（防止 Key 被写进配置文件/仓库）；
- **启动自检**：插件每次启动校验 `cordis.patch.yml` 的关键项（`apiKey` 必须为空、`model`/`timeoutMs`/`ffmpegPath` 基线），发现被改会自动备份并恢复基线；
- **运行时兜底**：`model`/`baseUrl`/`timeoutMs`/CDN 白名单等都有代码内置默认值，配置缺失或被改坏不影响功能；
- 注意：DSH 对 bundle patch 有寻址校验，patch 文件被改后插件会暂时无法加载（unaddressable），恢复文件后需重启 DSH 或重装 bundle。

## 隐私与安全

- 图片会以 **base64** 直接发给智谱接口（`open.bigmodel.cn`），本插件不落盘、不缓存图片内容；
- **微信 CDN 补图**（`cdnUrl`/`cdnMd5`）有硬安全边界：只接受域名后缀命中白名单的腾讯微信地址（默认 `weixin.qq.com`/`qpic.cn`/`gtimg.cn`/`qq.com` 等，可配），且必须提供原消息 md5 摘要、下载后逐字节核验，不匹配立即丢弃；重定向后仍会复查域名；下载的临时文件用完即删；
- **旧版地址兼容**：历史消息里的旧腾讯域名（如 `mmsns.qpic.cn`）会先映射到兼容域名（如 `shmmsns.qpic.cn`），http 一律强制升级为 **HTTPS**，映射后照常过白名单与 md5 核验；映射表可在配置里扩展；
- 不在本地保存任何聊天数据；面板保存的 Key 只存在于 DSH 的配置里；
- 建议只在可信会话里给 agent 开放这个工具（模型侧工具可按 preset 隔离）。

## 已知限制

- 单图 ≤5MB（超出报错，不自动压缩）
- 一次一张图；多图/长截图建议先裁切
- 情绪判断依赖模型理解，仅作聊天辅助，不做心理诊断
- 不支持视频、语音

## 许可证

MIT（见 LICENSE）。
