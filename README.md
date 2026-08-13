# j-can-see

English | [中文文档](./README.zh-CN.md)

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
| `J_SEE_TIMEOUT_MS` | No | `90000` | Vision call timeout in milliseconds |

Missing required variables → crash on startup with a clear reason (fail fast).

> `J_SEE_MODEL` has no default: use the vision model your endpoint actually supports. In testing, `grok-4.5` used fewer tokens than other candidates at equal description quality.

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

## Tool: `see_image`

```typescript
see_image({
  source: string,   // see table below
  prompt?: string   // omitted → "describe the image in detail, including text/UI/colors/layout"
}) → string         // text description returned by the model
```

## CLI

```bash
npx j-can-see --hook   # print the PreToolUse hook script; save it locally and wire it up in Claude Code settings
```

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
