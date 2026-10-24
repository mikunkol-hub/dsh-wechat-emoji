# dsh-wechat-emoji

让 DSH 的 agent **看懂聊天里的表情包 / 梗图 / 聊天截图，并判断对方情绪**。

注册一个模型侧工具 `wechat_emoji_analyze`，底层调用智谱 **GLM-4V-Flash**（免费视觉大模型）。

## 能力

| 输入 | 说明 |
|---|---|
| `image` | 本地图片路径（支持**无扩展名**的微信缓存文件）或 http(s) URL；jpg/jpeg/png/apng/webp(含动图)/gif(取首帧)/bmp/tiff/ico/avif/heic |
| `hint` | 可选。这条消息的文字/上下文（如「今天又加班」），显著提高情绪判断准确率 |

输出（结构化 JSON）：

| 字段 | 说明 |
|---|---|
| `sentiment` | 情绪类别：开心/生气/难过/无语/害羞/嘲讽/震惊/亲昵/期待/委屈/敷衍/中性 |
| `intensity` | 情绪强度 0–100 |
| `meaning` | 这张表情包在当前语境下想表达什么 |
| `replyHint` | 建议怎么回应（语气 + 一句话示例） |
| `description` | 画面内容（含图上的文字） |

微信自有格式 `.wxgf` 无法直接解码，会返回明确提示（请在微信里另存为 gif/png 再识别）。

## 快速开始

### 0) 准备

- 一个 DSH profile（`~/.dsh/profiles/<名字>`）
- 智谱 API Key：[open.bigmodel.cn](https://open.bigmodel.cn/) 注册后在「API 密钥」创建（GLM-4V-Flash 免费，新用户送额度）

### 1) 安装

**方式 A：npm 安装（推荐，已发布到 npm）**

```bash
dsh-wechat-emoji
```

> 要出现在 DSH 插件商城里，插件必须有 npm 包 —— 本插件已发布，直接装即可。

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

### 2) 配置 Key（二选一）

- **环境变量**（推荐）：设 `ZHIPU_API_KEY` 后重启 DSH，`cordis.patch.yml` 里的 `apiKey` 留空即可；
- **配置文件**：在 `cordis.patch.yml` 的 `apiKey` 填你的 Key。

改完 `cordis.patch.yml` 保存即触发 profile 热重载（一般不用重启 DSH）。

### 3) 验证

任意会话里让 agent 发一张表情包路径给它试试；或直接看工具列表里是否出现 `wechat_emoji_analyze`。

## 配置（cordis.patch.yml）

| 字段 | 默认 | 说明 |
|---|---|---|
| `apiKey` | `""` | 智谱 API Key；留空则读环境变量 `ZHIPU_API_KEY` |
| `model` | `glm-4v-flash` | 视觉模型名 |
| `baseUrl` | 智谱 v4 chat/completions | 兼容 OpenAI 格式的地址 |
| `timeoutMs` | `120000` | 单次请求超时 |
| `ffmpegPath` | 自动找 | 转码用；不填依次找 `FFMPEG` 环境变量、`~/.dsh/bili-whale/bin/ffmpeg.exe`、PATH |

> ffmpeg 只在「动图取首帧 / bmp·tiff·ico·avif·heic 等格式转码」时需要；只有 jpg/png 图片的场景没有它也能用。

## 隐私与安全

- 图片会以 **base64** 直接发给智谱接口（`open.bigmodel.cn`），本插件不落盘、不缓存图片内容；
- 不在本地保存任何聊天数据；
- 建议只在可信会话里给 agent 开放这个工具（模型侧工具可按 preset 隔离）。

## 已知限制

- 单图 ≤5MB（超出报错，不自动压缩）
- 一次一张图；多图/长截图建议先裁切
- 情绪判断依赖模型理解，仅作聊天辅助，不做心理诊断
- 不支持视频、语音

## 许可证

MIT（见 LICENSE）。
