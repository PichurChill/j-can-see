# j-can-see

English | [中文文档](./README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/j-can-see)](https://www.npmjs.com/package/j-can-see)
[![npm downloads](https://img.shields.io/npm/dm/j-can-see)](https://www.npmjs.com/package/j-can-see)
[![license: MIT](https://img.shields.io/npm/l/j-can-see)](https://www.npmjs.com/package/j-can-see)

An MCP server that sends images (local file / URL / clipboard / latest screenshot) to a vision model and returns a text description.

**Who is it for**: AI coding clients like Claude Code / Codex whose primary model has **no multimodal input** (can't see images). Use the `see_image` tool to outsource vision.

## The problem it solves

When the primary model doesn't support image input, `Read`-ing an image or pasting a screenshot into the conversation causes a direct 400 at the API layer and the whole turn crashes — the model never sees a "failure" event and can't recover on its own.

`j-can-see` turns vision into an **ordinary text tool call**: the model passes a path/URL and gets back a text description — usable by any text-only model.

## Quick start

### One-liner (recommended)

```bash
claude mcp add j-can-see -s user \
    -e J_SEE_TOKEN='your-key' \
    -e J_SEE_BASE_URL='https://your-proxy.example' \
    -e J_SEE_MODEL='grok-4.5' \
    -- npx -y j-can-see
```

> `-s user` writes the config to `~/.claude.json` (outside any git repo), so the key never leaks.

### Manual configuration

Add this to the `mcpServers` section of `~/.claude.json`:

```jsonc
"j-can-see": {
  "command": "npx",
  "args": ["-y", "j-can-see"],
  "env": {
    "J_SEE_TOKEN": "your vision model key",
    "J_SEE_BASE_URL": "https://your-proxy.example",
    "J_SEE_MODEL": "grok-4.5"
  }
}
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `J_SEE_TOKEN` | Yes | — | Vision model API key (**not hardcoded — must be set explicitly**) |
| `J_SEE_BASE_URL` | Yes | — | Vision endpoint base URL (must match `J_SEE_API_SPEC`; trailing slashes are stripped) |
| `J_SEE_MODEL` | Yes | — | Vision model name (**must be set explicitly**) |
| `J_SEE_API_SPEC` | No | `responses` | Upstream API spec (see below): `responses` / `openai` / `anthropic` |
| `J_SEE_REASONING` | No | `none` | Reasoning effort (**only honored by the `openai` spec**): `none` / `low` / `medium` / `high` |
| `J_SEE_MAX_EDGE` | No | `1568` | Max long-edge pixels for image compression |
| `J_SEE_MAX_BYTES` | No | `52428800` | Max source file size in bytes; larger is rejected |
| `J_SEE_MAX_PIXELS` | No | `40000000` | Max decoded pixels (w×h), checked from the image header **before** decoding. `J_SEE_MAX_BYTES` only caps *compressed* size — a mostly-solid PNG can be a few KB yet decode to a multi-GB bitmap |
| `J_SEE_TIMEOUT_MS` | No | `90000` | Timeout per vision call (ms) |
| `J_SEE_OCR_TOTAL_TIMEOUT_MS` | No | `85000` | Total time budget for multi-chunk `ocr_long` (ms). When exhausted it **does not fail**: returns completed chunks plus the y-ranges of unprocessed ones. Default 85s stays under common client-side MCP tool timeouts (e.g. ZCode's 100s) |

Missing `J_SEE_TOKEN` / `J_SEE_BASE_URL` / `J_SEE_MODEL` does **not** stop the server: local pixel tools keep working (a warning goes to stderr) and vision tools return a clear config error when called. Malformed values in any variable still fail fast.

> `J_SEE_MODEL` has no default: use the vision model your endpoint actually supports. In testing, `grok-4.5` used fewer tokens than other candidates at equal description quality.

### Timeouts (three layers)

| Layer | Default | Behavior |
|---|---|---|
| Per vision call | `J_SEE_TIMEOUT_MS` = 90s | Aborts actively, reports a clear timeout error |
| `ocr_long` total budget | `J_SEE_OCR_TOTAL_TIMEOUT_MS` = 85s | Returns partial results + y-ranges of unprocessed chunks (never fails wholesale) |
| Client MCP tool timeout | e.g. ZCode 100s | Hard wall — the default budget deliberately leaves headroom |

If your client's tool timeout is shorter (or you want to swallow longer images in one go), raise the client timeout or `J_SEE_OCR_TOTAL_TIMEOUT_MS`. For very tall images (>20k px), pre-splitting with `crop` and running `ocr_long` per segment is more reliable.

### Model choice (locate / inspect depend on grounding)

`locate`/`inspect` require the model to emit precise bounding boxes (grounding), which varies a lot between models: in testing `grok-4.5/4.6` describe images fine but ground weakly (frequent NOT_FOUND). For coordinate work prefer models with stronger grounding (Gemini, Qwen-VL, etc.). `J_SEE_MODEL` is global — if your proxy serves multiple models, register a second server instance for locating tasks.

### API specs (`J_SEE_API_SPEC`)

Three upstream specs, default `responses`:

| Value | Endpoint | Use case |
|---|---|---|
| `responses` (default) | `/v1/responses` | OpenAI Responses — native API for GPT-5 / Codex; aligns with the cc switch / Codex ecosystem |
| `openai` | `/v1/chat/completions` | OpenAI Chat Completions — compatible with all OpenAI-compatible proxies (OpenRouter / LiteLLM / CLIProxyAPI / one-api, etc.) |
| `anthropic` | `/v1/messages` | Anthropic Messages — can call the Claude native API directly, no proxy needed |

**Direct Claude (`anthropic`)**: call Anthropic directly without any OpenAI-compatible proxy:

```bash
claude mcp add j-can-see -s user \
    -e J_SEE_API_SPEC='anthropic' \
    -e J_SEE_TOKEN='sk-ant-...' \
    -e J_SEE_BASE_URL='https://api.anthropic.com' \
    -e J_SEE_MODEL='claude-sonnet-4-5-20250929' \
    -- npx -y j-can-see
```

> - `J_SEE_REASONING` is ignored under `responses` / `anthropic` (only `openai` honors it).
> - In practice, none of the three specs can fully turn off reasoning — the translation layer doesn't pass through effort, so a single vision call still burns a few hundred reasoning tokens (`responses` ≈ 500, `openai` ≈ 900, `anthropic` keeps thinking off by default). Quality is unaffected; this is acceptable.
> - Default `responses`: if your proxy doesn't support `/v1/responses` (returns 404), the error message will suggest setting `J_SEE_API_SPEC=openai` (**no silent fallback** — errors are reported as-is, and you decide explicitly to switch specs).

## Tools

j-can-see ships 9 tools; the AI picks the right one for the task. Your workflow stays the same (paste an image + a one-line instruction) — the capability lives in the tools.

### Vision tools (call the vision model, share `J_SEE_*` config)

| Tool | Question it answers |
|---|---|
| `see_image` | What's in this image? (supports `region` zoom-in, multi-image compare) |
| `locate` | Where is this one thing? → pixel coords of a single target |
| `inspect` | Where are all of these? → numbered list + text + coords |
| `ocr_long` | Text in this tall screenshot? → chunked OCR, merged, with a per-boundary dedup audit (including the boundaries it could **not** dedup) |

### Local tools (pure pixel ops, no vision model, **no vision config needed**)

> Local-only mode: the server starts and all local tools work even with zero `J_SEE_*` env vars (a stderr warning notes the missing vision config; vision tools are validated lazily at call time and return a clear config error).

| Tool | Question it answers |
|---|---|
| `crop` | Cut this box out as a file (optional upscale; encodes .png/.jpg by extension) |
| `image_diff` | What changed between these two? → diff% + the densest grid cells (12×12 split, **not** exact bounding boxes) |
| `colors` | What's the exact color here? → precise hex (+ candidate match). Buckets colors 5-bit: great for flat UI colors, gradients get split across buckets |
| `trace` | Vector shape of this flat graphic? → SVG |
| `extract_fg` | Extract this icon as a transparent PNG |

> **Coordinates are always original-image pixels**: coords from `locate`/`inspect` feed directly into the `region` param of `see_image`/`crop`.
>
> **Core principle**: never trust a prose answer for a pixel-level fact (color/size/coords). Use `colors` / `image_diff` / `trace` for ground truth.

### `see_image`

```typescript
see_image({
  source: string | string[],   // single image or multi-image compare
  prompt?: string,             // omitted → "describe the image in detail, including text/UI/colors/layout"
  region?: "x1,y1,x2,y2"       // original-image pixels, crop-then-look (pairs with locate/inspect)
}) → string                    // text description returned by the model
```

> See [`SKILL.md`](./SKILL.md) for the full usage methodology and playbooks.

## CLI

```bash
npx j-can-see --hook         # print the PreToolUse hook script; save it locally and wire it up in Claude Code settings
npx j-can-see --skill        # install SKILL.md as an Agent Skill into ~/.claude/skills, ~/.agents/skills and ~/.codex/skills
npx j-can-see --print-skill  # print SKILL.md contents so you can place it yourself
```

> The MCP server ships tools only — tool descriptions are the sole text an MCP client is
> guaranteed to inject into model context. The methodology in SKILL.md (including the
> `.j-can-see/` output-path convention) reaches the model via the separate Agent Skills
> mechanism; **the server installs it automatically on every start** (skipped when the
> content is unchanged; disable with `J_SEE_SKILL_AUTO_INSTALL=0`), so no manual step is
> needed. The two commands below exist for manual install/inspection and are not required.

## Installing the skill into other AI tools (manual)

Auto-install currently covers four locations: Claude Code–specific `~/.claude/skills`,
Codex-specific `~/.codex/skills`, the cross-tool shared directory `~/.agents/skills`
(read by Claude/Codex/Cursor/ZCode and others — one copy serves every tool), and
ZCode-specific `~/.zcode/skills`.
For any other AI tool (especially less mainstream clients), install manually using
`~/.codex` as the example:

```bash
# 1. Create the skill directory: ~/.<tool-name>/skills/<skill-name>/
mkdir -p ~/.codex/skills/j-can-see

# 2. Write SKILL.md into it (--print-skill outputs the version bundled with this package)
npx j-can-see --print-skill > ~/.codex/skills/j-can-see/SKILL.md
# or copy from the repo: cp SKILL.md ~/.codex/skills/j-can-see/

# 3. Restart the AI tool; new sessions pick it up
```

Notes:

- **The directory name is the skill name**: `j-can-see` in `~/.<tool-name>/skills/j-can-see/`
  must not be renamed; the file must be named `SKILL.md` and start with `---` frontmatter
  (`name` + `description`) — Agent Skills–compliant tools discover skills via these three.
- **Not sure where a tool keeps its skills directory?** Look up "skills" / "Agent Skills"
  in that tool's docs. The usual convention is user-global `~/.<tool-name>/skills/<skill-name>/SKILL.md`;
  `~/.agents/skills` is a cross-tool shared directory (Claude/Codex/Cursor/ZCode and others
  read it), so one copy there serves every such tool; some tools also support project-level
  `<project>/.<tool-name>/skills/<skill-name>/SKILL.md` (copy SKILL.md there to scope it to
  that project only).
- **Verify**: `ls ~/.codex/skills/j-can-see/` should show SKILL.md; after restarting the
  tool, `j-can-see` should appear in the session's skill list and load on image tasks.

### Why a skill is needed (MCP alone is not enough)

- **MCP only guarantees tool descriptions reach the model**: each tool returned by
  `tools/list` carries name / description / inputSchema — the only text every client
  injects unconditionally. That's why the critical output-path convention also lives in
  the `output` parameter descriptions of crop / extract_fg / trace (the safety net).
- **The full methodology cannot fit in tool descriptions**: the tool-selection decision
  tree, coarse-to-fine workflow, five scenario playbooks and boundary warnings are
  hundreds of lines; embedding them would bloat every session by thousands of tokens.
- **Progressive disclosure**: only the one-line frontmatter description stays resident
  (tens of tokens); SKILL.md loads in full only when the model decides the task involves
  image work — rich knowledge at minimal context cost.
- **Division of labor**: MCP provides capability (9 callable tools), the skill provides
  knowledge (how to use them well). Without the skill everything still works, but the
  model lacks orchestration knowledge — in real sessions the AI left stray files under
  self-chosen `/tmp` directories and let long-image OCR time out entirely, classic
  symptoms of missing methodology.

### `source` values

| Value | Description |
|---|---|
| Local path | Supports `~` expansion, e.g. `~/Desktop/a.png`, `./logo.jpg` |
| `http(s)://` URL | Downloaded then described (content-type must be `image/*`) |
| `"clipboard"` | Image in the system clipboard (mac / win only) |
| `"latest"` | Most recent image in the screenshot directory |

## Claude Code setup (MCP + Hook)

### 1. MCP server

See "Quick start" above; write to `~/.claude.json` or a project-level `.mcp.json`.

### 2. PreToolUse Hook (recommended)

Without it, the model's instinct when it sees an image path is to `Read` it — which triggers that 400. The hook intercepts the request first and redirects to `see_image`:

**Step 1: export the hook script**

```bash
npx j-can-see --hook > ~/.claude/hooks/block-image-read.mjs
chmod +x ~/.claude/hooks/block-image-read.mjs
```

**Step 2: configure Claude Code**

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

> The hook is deliberately conservative: it only intercepts `Read` calls on image file extensions. Multimodal models don't `Read` images (they consume image blocks directly), so the hook never misfires for them.

## Codex setup

Codex has no PreToolUse interception, so rely on an `AGENTS.md` convention:

```markdown
## Image recognition
This session's primary model has no multimodal capability; do not use view_image or read images directly.
To describe an image, call the MCP tool see_image({ source }).
```

Less reliable than the hook, but it's all Codex supports for now.

## Why these defaults (measured, not guessed)

| Default | Evidence |
|---|---|
| `J_SEE_API_SPEC=responses` | The Responses endpoint (CLIProxyAPI + grok-4.6) works for vision in testing; reasoning tokens (≈500) are actually lower than Chat Completions (≈900), and it aligns with Codex / cc switch |
| `J_SEE_REASONING=none` | **Doesn't truly disable reasoning** (the translation layer never forwards 0; ~900 reasoning tokens per vision call remain), but it's about twice as fast, saves ~28% tokens, and quality is unaffected |
| Forced `User-Agent` header | Cloudflare bot protection returns 403 for default UAs (tested: urllib got 403) |
| 90s timeout | Shorter than Cloudflare Tunnel's 100s cap, so clients get a clear error before a 524 |

## Sharing with others

The command for a friend is identical to yours — just replace `J_SEE_TOKEN` with a key issued for them.

```bash
claude mcp add j-can-see -s user \
    -e J_SEE_TOKEN='friend-specific-key' \
    -e J_SEE_BASE_URL='https://your-proxy.example' \
    -e J_SEE_MODEL='grok-4.5' \
    -- npx -y j-can-see
```

### Key safety: one per person, never shared

CLIProxyAPI's `api-keys` is a flat array — all keys have equal permissions (no per-key model whitelist or quota). **Never hand your main key to a friend.**

Create a separate key per person on the server:
```yaml
# /root/CLIProxyAPI/config.yaml
api-keys:
  - sk-your-main-key      # ← never give this to anyone
  - sk-friend-A           # ← friend A. If a key misbehaves, delete just that one
  - sk-friend-B           # ← friend B
```

### Do you need a gateway (quota / model whitelist)?

CLIProxyAPI currently has no per-key quota or model restrictions — a friend with a key can call every model on your backend (including expensive ones like video generation). If you trust your friends, no extra gateway is needed; if you need quotas/whitelists, add a thin gateway in front.

### If the server side is CLIProxyAPI

**No server-side changes needed** — just point `J_SEE_BASE_URL` at it, since it already has HTTPS (Cloudflare Tunnel) + auth (`api-keys`) + OpenAI image compatibility.

## Limitations

- **No Linux clipboard**: `source: "clipboard"` errors out clearly on Linux; use a file path instead (a declared boundary, not a silent fallback)
- Transparent PNGs are converted to JPEG (alpha becomes black); irrelevant for text screenshots
- No retries, no fallback: vision failures are reported as-is; the caller decides

## Development

```bash
npm install
npm test        # vitest
npm run build   # tsc → dist/
```

### Publishing

```bash
# 1. Bump version in package.json (e.g. 0.1.0 → 0.1.1)
# 2. Build
npm run build
# 3. Publish to npm (always use the official registry, even if a mirror is configured globally)
npm publish --registry=https://registry.npmjs.org/
```
