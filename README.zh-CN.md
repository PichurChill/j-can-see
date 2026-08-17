# j-can-see

[English](./README.md) | 中文

[![npm version](https://img.shields.io/npm/v/j-can-see)](https://www.npmjs.com/package/j-can-see)
[![npm downloads](https://img.shields.io/npm/dm/j-can-see)](https://www.npmjs.com/package/j-can-see)
[![license: MIT](https://img.shields.io/npm/l/j-can-see)](https://www.npmjs.com/package/j-can-see)

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
    -e J_SEE_MODEL='grok-4.5' \
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
    "J_SEE_BASE_URL": "https://你的代理地址",
    "J_SEE_MODEL": "grok-4.5"
  }
}
```

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `J_SEE_TOKEN` | 是 | — | 视觉模型的 API key（**不内嵌，必须显式配置**） |
| `J_SEE_BASE_URL` | 是 | — | 视觉模型端点根地址（需与 `J_SEE_API_SPEC` 匹配；末尾斜杠自动去除） |
| `J_SEE_MODEL` | 是 | — | 视觉模型名（**必须显式配置**） |
| `J_SEE_API_SPEC` | 否 | `responses` | 上游 API 规范（见下）：`responses` / `openai` / `anthropic` |
| `J_SEE_REASONING` | 否 | `none` | 推理强度（**仅 `openai` 规范生效**）：`none` / `low` / `medium` / `high` |
| `J_SEE_MAX_EDGE` | 否 | `1568` | 图片压缩长边像素上限 |
| `J_SEE_MAX_BYTES` | 否 | `52428800` | 源文件体积上限（字节），超出拒绝 |
| `J_SEE_MAX_PIXELS` | 否 | `40000000` | 解码后像素数上限（宽×高），**在解码前**从图片 header 读尺寸判定。`J_SEE_MAX_BYTES` 管的是*压缩后*体积——大面积纯色 PNG 可以只有几 KB 却解出巨大 bitmap |
| `J_SEE_TIMEOUT_MS` | 否 | `90000` | 单次视觉调用超时（毫秒） |
| `J_SEE_OCR_TOTAL_TIMEOUT_MS` | 否 | `85000` | `ocr_long` 多块总时间预算（毫秒）。预算耗尽**不报错**：返回已完成的块并列出未处理块的 y 区间。默认 85s，刻意低于常见客户端的 MCP 工具级超时（如 ZCode 的 100s） |

缺 `J_SEE_TOKEN` / `J_SEE_BASE_URL` / `J_SEE_MODEL` **不影响 server 启动**：本地像素工具照常可用（stderr 留一条提示），视觉工具在被调用时返回清晰的配置错误。任何变量填了非法值仍然 fail fast。

> `J_SEE_MODEL` 无默认值：填你的代理实际支持的视觉模型名。实测 `grok-4.5` 在同等识图质量下 token 消耗较低，可作为参考选择。

### 超时机制（三层）

| 层 | 默认 | 行为 |
|---|---|---|
| 单次视觉调用 | `J_SEE_TIMEOUT_MS` = 90s | 超时主动掐断，报「视觉调用超时」 |
| `ocr_long` 总预算 | `J_SEE_OCR_TOTAL_TIMEOUT_MS` = 85s | 耗尽返回部分结果 + 未处理块 y 区间（不整单失败） |
| 客户端 MCP 工具超时 | 如 ZCode 100s | 客户端硬墙——总预算默认值刻意留了余量 |

如果你的客户端工具超时较短（或想一次吃下更长的图），调大客户端超时或调大 `J_SEE_OCR_TOTAL_TIMEOUT_MS`；图特别长（>2 万 px）时更稳的做法是先 `crop` 分段、逐段 `ocr_long`。

### 模型选型（locate / inspect 依赖定位能力）

`locate`/`inspect` 需要模型输出精确边界框（grounding），不同模型差距很大：实测 `grok-4.5/4.6` 识图描述可用但定位偏弱（可能频繁 NOT_FOUND）；坐标定位任务建议配 grounding 更强的模型（Gemini、Qwen-VL 系列等）。`J_SEE_MODEL` 是全局的——如果你的代理支持多模型，可以为定位任务单独配一个 server 实例。

### API 规范（`J_SEE_API_SPEC`）

三种上游规范，默认 `responses`：

| 取值 | 端点 | 适用场景 |
|---|---|---|
| `responses`（默认） | `/v1/responses` | OpenAI Responses，GPT-5 / Codex 原生接口，与 cc switch / Codex 生态对齐 |
| `openai` | `/v1/chat/completions` | OpenAI Chat Completions，兼容所有 OpenAI 兼容代理（OpenRouter / LiteLLM / CLIProxyAPI / one-api 等） |
| `anthropic` | `/v1/messages` | Anthropic Messages，可不经代理直连 Claude 原生 API |

**直连 Claude（`anthropic`）**：不经任何 OpenAI 兼容代理、直接调用 Anthropic：

```bash
claude mcp add j-can-see -s user \
    -e J_SEE_API_SPEC='anthropic' \
    -e J_SEE_TOKEN='sk-ant-...' \
    -e J_SEE_BASE_URL='https://api.anthropic.com' \
    -e J_SEE_MODEL='claude-sonnet-4-5-20250929' \
    -- npx -y j-can-see
```

> - `responses` / `anthropic` 规范下 `J_SEE_REASONING` 不生效（仅 `openai` 生效）。
> - 三种规范实测都**关不掉推理**——转换层不透传 effort，单次识图仍有数百 reasoning tokens（`responses` ≈ 500、`openai` ≈ 900、`anthropic` 不开 thinking），识别质量无损，可接受。
> - 默认 `responses`：若你的代理不支持 `/v1/responses`（返回 404），错误信息会提示"可设置 `J_SEE_API_SPEC=openai`"（**不静默降级**——失败原样上报，由你显式决定换规范）。

## 工具集

j-can-see 提供 9 个工具，AI 会根据任务自动选择——你的使用方式不变（贴图 + 一句话指令），能力长在工具里。

### 视觉工具（调用视觉模型，共用 `J_SEE_*` 配置）

| 工具 | 回答的问题 |
|---|---|
| `see_image` | 这张图是什么 / 说了什么？（支持 `region` 局部放大、多图对比） |
| `locate` | 某个东西在哪？→ 单个目标的像素坐标 |
| `inspect` | 所有同类元素在哪？→ 编号列表 + 文字 + 坐标 |
| `ocr_long` | 这张超长截图的文字？→ 分块 OCR + 合并去重，并逐条报告边界处理结果（含**未能去重**的边界） |

### 本地工具（纯像素操作，不调视觉模型，**无需视觉配置**）

> 纯本地模式：即使完全不配置 `J_SEE_*` 环境变量，server 也能启动，本地工具全部可用（启动时 stderr 会提示视觉配置缺失；调用视觉工具时才校验并返回清晰的配置错误）。

| 工具 | 回答的问题 |
|---|---|
| `crop` | 把这块裁出来存成文件（可放大，按扩展名编码 .png/.jpg） |
| `image_diff` | 这两张图哪里不同？→ 差异% + 差异密度最高的网格块（12×12 等分，**非精确包围盒**） |
| `colors` | 这里到底是什么颜色？→ 精确色值（不靠"浅灰"这种模糊描述）。按 5 位量化分桶：适合 UI 纯色，渐变会被打散 |
| `trace` | 这个图形的矢量形状？→ SVG（仅适合扁平高对比图形） |
| `extract_fg` | 把这个图标抠成透明 PNG |

> **坐标系统一为原图像素**：`locate` / `inspect` 返回的坐标可直接喂给 `see_image` / `crop` 的 `region` 参数。
>
> **核心原则**：像素级事实（颜色 / 坐标 / 差异）不信任视觉模型的文字描述——用 `colors` / `image_diff` / `trace` 取真值。

### `see_image`

```typescript
see_image({
  source: string | string[],   // 单图或多图对比
  prompt?: string,             // 省略则"详细描述图片内容，含文字/UI/颜色/布局"
  region?: "x1,y1,x2,y2"       // 原图像素坐标，先裁后看（常配合 locate/inspect）
}) → string                    // 模型返回的文字描述
```

> 更详细的使用方法论与场景 playbook 见 [`SKILL.md`](./SKILL.md)。

## CLI 命令

```bash
npx j-can-see --hook         # 输出 PreToolUse hook 脚本内容，写入本地磁盘后配合 Claude Code settings 使用
npx j-can-see --skill        # 把 SKILL.md 安装为 Agent Skill（~/.claude/skills、~/.agents/skills、~/.codex/skills）
npx j-can-see --print-skill  # 打印 SKILL.md 内容，自行放置
```

> MCP server 只带工具不带文档——工具描述是 MCP 客户端唯一保证注入模型上下文的文本。
> SKILL.md 里的方法论（含 `.j-can-see/` 落盘约定）走的是独立的 Agent Skills 通道；
> **server 每次启动会自动安装**（内容一致则跳过写盘，可用 `J_SEE_SKILL_AUTO_INSTALL=0` 关闭），
> 无需手动操作。下面两个命令仅供手动安装/查看，正常情况下用不到。

## 安装 skill 到其他 AI 工具（手动）

自动安装目前覆盖四个位置：Claude Code 专属 `~/.claude/skills`、Codex 专属 `~/.codex/skills`、
跨工具共享目录 `~/.agents/skills`（Claude/Codex/Cursor/ZCode 等都会读，放一份多个工具共享）、
ZCode 专属 `~/.zcode/skills`。
如果以后使用其他 AI 工具（尤其是非主流客户端），按下面步骤手动安装，以 `~/.codex` 为例：

```bash
# 1. 创建技能目录：~/.<工具名>/skills/<技能名>/
mkdir -p ~/.codex/skills/j-can-see

# 2. 把 SKILL.md 写入该目录（--print-skill 输出随包当前版本）
npx j-can-see --print-skill > ~/.codex/skills/j-can-see/SKILL.md
# 或直接从仓库复制：cp SKILL.md ~/.codex/skills/j-can-see/

# 3. 重启该 AI 工具，新会话生效
```

要点：

- **目录名即技能名**：`~/.<工具名>/skills/j-can-see/` 里的 `j-can-see` 不能改；文件必须叫 `SKILL.md`，且以 `---` frontmatter（`name` + `description`）开头——遵循 Agent Skills 规范的工具靠这三样发现技能
- **不确定某工具的 skills 目录在哪**：查该工具文档中 "skills" / "Agent Skills" 一节。一般约定是用户全局 `~/.<工具名>/skills/<技能名>/SKILL.md`；`~/.agents/skills` 是跨工具共享目录（Claude/Codex/Cursor/ZCode 等都读），放一份即多个工具生效；部分工具还支持项目级 `<项目>/.<工具名>/skills/<技能名>/SKILL.md`（后者可把 SKILL.md 复制进去，仅对该项目生效）
- **验证**：`ls ~/.codex/skills/j-can-see/` 应能看到 SKILL.md；重启工具后，会话的技能列表里应出现 `j-can-see`，看图任务时自动加载全文

### 为什么需要 skill（而不只靠 MCP）

- **MCP 通道只保证工具描述进模型上下文**：`tools/list` 返回的每个工具只有 name / description / inputSchema，这是所有客户端唯一必然注入的文本。所以最关键的落盘约定写进了 crop / extract_fg / trace 的 `output` 参数描述——这是保底
- **完整方法论塞不进工具描述**：工具选择决策树、粗到细流程、5 个场景 playbook、边界警告有几百行，塞进去会让每个会话上下文凭空膨胀几千 token
- **Agent Skills 的渐进披露（progressive disclosure）**：skill 只有一行 frontmatter description 常驻上下文（几十 token），模型判断任务与看图相关时才加载 SKILL.md 全文——知识丰富但上下文开销极小
- **分工**：MCP 给能力（9 个工具可调用），skill 给知识（怎么用得对）。没有 skill 功能照常可用，但 AI 缺少编排知识——实测会话中 AI 自选 `/tmp` 目录散落文件无人清理、长截图 OCR 整单超时，都是缺方法论的表现

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
| `J_SEE_API_SPEC=responses` | 实测 Responses 端点（CLIProxyAPI + grok-4.6）识图可用；reasoning tokens（≈500）反而低于 Chat Completions（≈900），且与 Codex / cc switch 生态对齐 |
| `J_SEE_REASONING=none` | **未真正关闭推理**（转换层未透传到 0，单次识图仍有约 900 reasoning tokens），但比默认快约一倍、省约 28% token、识别质量无损 |
| 强制 `User-Agent` 头 | Cloudflare bot 防护会对默认 UA 返回 403（实测 urllib 被 403） |
| 超时 90s | 短于 Cloudflare Tunnel 的 100s 上限，让客户端先于 524 给出清晰错误 |

## 分享给他人

给朋友的命令和你的完全一样：只是 `J_SEE_TOKEN` 换成给朋友的 key。

```bash
claude mcp add j-can-see -s user \
    -e J_SEE_TOKEN='给朋友的独立key' \
    -e J_SEE_BASE_URL='https://你的代理地址' \
    -e J_SEE_MODEL='grok-4.5' \
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
