# j-can-see

一个 MCP server：把图片（本地文件 / URL / 剪贴板 / 最近截图）交给视觉模型，返回文字描述。

**给谁用**：Claude Code / Codex 等 AI 编程客户端，当其主模型**没有多模态输入能力**（看不了图）时，用 `see_image` 工具外包识图。

## 它解决什么问题

当主模型不支持图片输入时，直接 `Read` 一张图或把截图粘进对话，会在 API 请求层直接 400，整个 turn 崩溃——模型拿不到"失败"事件，无法自救。

`j-can-see` 让识图变成一个**普通文本工具调用**：模型传一个路径/URL，拿到一段文字描述，纯文本模型也能消费。

## 快速开始

### 一行命令（推荐）

```bash
claude mcp add j-can-see -s user \
    -e J_SEE_TOKEN='你的key' \
    -e J_SEE_BASE_URL='https://你的代理地址' \
    -- npx -y j-can-see
```

> `-s user` 确保配置写在 `~/.claude.json`（不在任何 git 仓库里），key 不会泄露。

### 手动配置

在 `~/.claude.json` 的 `mcpServers` 下加：

```jsonc
"j-can-see": {
  "command": "npx",
  "args": ["-y", "j-can-see"],
  "env": {
    "J_SEE_TOKEN": "你的视觉模型 key",
    "J_SEE_BASE_URL": "https://你的代理地址"
  }
}
```

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `J_SEE_TOKEN` | 是 | — | 视觉模型的 API key（**不内嵌，必须显式配置**） |
| `J_SEE_BASE_URL` | 是 | — | OpenAI 兼容端点根地址（末尾斜杠自动去除） |
| `J_SEE_MODEL` | 否 | `grok-4.5` | 视觉模型名 |
| `J_SEE_REASONING` | 否 | `none` | 推理强度：`none` / `low` / `medium` / `high` |
| `J_SEE_MAX_EDGE` | 否 | `1568` | 图片压缩长边像素上限 |
| `J_SEE_MAX_BYTES` | 否 | `52428800` | 源文件体积上限（字节），超出拒绝 |
| `J_SEE_TIMEOUT_MS` | 否 | `90000` | 视觉调用超时（毫秒） |

缺必填项 → 启动即崩并打印原因（fail fast）。

## 工具：`see_image`

```typescript
see_image({
  source: string,   // 见下表
  prompt?: string   // 省略则"详细描述图片内容，含文字/UI/颜色/布局"
}) → string         // 模型返回的文字描述
```

## CLI 命令

```bash
npx j-can-see --hook   # 输出 PreToolUse hook 脚本内容，写入本地磁盘后配合 Claude Code settings 使用
```

### `source` 来源

| 值 | 说明 |
|---|---|
| 本地路径 | 支持 `~` 展开，如 `~/Desktop/a.png`、`./logo.jpg` |
| `http(s)://` URL | 下载后识别（校验 content-type 为 `image/*`） |
| `"clipboard"` | 系统剪贴板中的图片（仅 mac / win） |
| `"latest"` | 截图目录中最新一张图 |

## Claude Code 配置（MCP + Hook）

### 1. MCP server

见上方"快速开始"，写入 `~/.claude.json` 或项目 `.mcp.json`。

### 2. PreToolUse Hook（推荐）

否则模型看到图片路径的本能反应是 `Read`，一读就触发那个 400。Hook 在请求前拦截并引导到 `see_image`：

**第一步：导出 hook 脚本**

```bash
npx j-can-see --hook > ~/.claude/hooks/block-image-read.mjs
chmod +x ~/.claude/hooks/block-image-read.mjs
```

**第二步：配置 Claude Code**

```jsonc
// ~/.claude/settings.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/hooks/block-image-read.mjs"
          }
        ]
      }
    ]
  }
}
```

> hook 判断逻辑很保守：只在"调用 Read 且文件是图片后缀"时才拦截。多模态模型不会主动 Read 图片（直接看 image block），所以 hook 不会误拦。

## Codex 配置

Codex 无 PreToolUse 拦截机制，靠 `AGENTS.md` 约定：

```markdown
## 图片识别
本会话的主模型无多模态能力，禁止用 view_image / 直接读图片。
需要识图时，调用 MCP 工具 see_image({ source })。
```

可靠性弱于 hook，但 Codex 侧目前只能如此。

## 默认参数的来由（实测，非猜测）

| 默认值 | 实测依据 |
|---|---|
| `J_SEE_MODEL=grok-4.5` | 同等识图质量下 token 消耗低于其他候选 |
| `J_SEE_REASONING=none` | **未真正关闭推理**（转换层未透传到 0，单次识图仍有约 900 reasoning tokens），但比默认快约一倍、省约 28% token、识别质量无损 |
| 强制 `User-Agent` 头 | Cloudflare bot 防护会对默认 UA 返回 403（实测 urllib 被 403） |
| 超时 90s | 短于 Cloudflare Tunnel 的 100s 上限，让客户端先于 524 给出清晰错误 |

## 分享给他人

给朋友的命令和你的完全一样：只是 `J_SEE_TOKEN` 换成给朋友的 key。

```bash
claude mcp add j-can-see -s user \
    -e J_SEE_TOKEN='给朋友的独立key' \
    -e J_SEE_BASE_URL='https://你的代理地址' \
    -- npx -y j-can-see
```

### Key 安全：每人独立，不共用

CLIProxyAPI 的 `api-keys` 是扁平数组——所有 key 权限等价（没有 per-key 模型白名单或配额）。**绝对不要把你自己主力 key 发给朋友。**

在服务器上每人单独建 key：
```yaml
# /root/CLIProxyAPI/config.yaml
api-keys:
  - sk-你的主力key     # ← 永远不给任何人
  - sk-朋友A专用       # ← 朋友A。谁出问题删谁的，不影响其他人
  - sk-朋友B专用       # ← 朋友B
```

### 要不要加 gateway（限额/模型白名单）

CLIProxyAPI 目前没有 per-key 的配额或模型限制——朋友拿到 key 后能调你后台所有模型（包括生成视频等贵模型）。如果你信得过朋友，不需要额外网关；如果需要限额/白名单，需另加一层薄 gateway。

### 如果服务器端是 CLIProxyAPI

**服务器侧无需任何改动**，直接把它的地址填进 `J_SEE_BASE_URL` 即可，因为它已具备 HTTPS（Cloudflare Tunnel）+ 鉴权（`api-keys`）+ OpenAI 图像兼容。

## 限制

- **Linux 剪贴板不支持**：`source: "clipboard"` 在 Linux 会明确报错，请改用文件路径（这是能力边界声明，非降级）
- 透明 PNG 会转 JPEG（透明通道丢失为黑底），对含文字截图无影响
- 不重试、不降级：视觉调用失败原样上报，由调用方决策

## 开发

```bash
npm install
npm test        # vitest
npm run build   # tsc → dist/
```

### 发版

```bash
# 1. 改 package.json 的 version（如 0.1.0 → 0.1.1）
# 2. 构建
npm run build
# 3. 发到 npm（务必指定官方 registry，即便全局配了淘宝镜像）
npm publish --registry=https://registry.npmjs.org/
```
