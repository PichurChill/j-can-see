/**
 * 视觉调用：把 base64 图片交给视觉模型，返回文本描述。
 *
 * 支持三种上游 API 规范（由 J_SEE_API_SPEC 选择）：
 *  - responses：OpenAI Responses（/v1/responses），GPT-5 / Codex 原生接口，
 *    与 cc switch / Codex 生态对齐（默认）
 *  - openai：OpenAI Chat Completions（/v1/chat/completions），兼容所有
 *    OpenAI 兼容代理（OpenRouter / LiteLLM / CLIProxyAPI / one-api 等）
 *  - anthropic：Anthropic Messages（/v1/messages），可直连 Claude 原生 API
 *
 * 实现要点（均来自实测，非猜测）：
 * 1. 强制 User-Agent —— CF bot 防护会对默认/空 UA 返回 403
 * 2. 超时短于 CF Tunnel 的 100s 上限，让客户端先于 524 给出清晰错误
 * 3. 不重试、不降级 —— 失败原样上报，调用方据 status 决策
 */
import { VisionError } from "./errors.js";
import type { AppConfig } from "./config.js";

export interface VisionInput {
  readonly base64: string;
  readonly mime: string;
  readonly prompt: string;
}

/** 可注入的 fetch 类型，便于测试用 mock 替换 */
export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/** 规范无关的请求描述：构造好后交给统一的 fetch / 错误处理流程 */
interface VisionRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Anthropic Messages API 要求的版本头 */
const ANTHROPIC_VERSION = "2023-06-01";

/** 三种规范共用的 UA */
const USER_AGENT = "j-can-see/0.1 (mcp-vision-client)";

/**
 * OpenAI Responses 请求（/v1/responses，GPT-5 / Codex 原生接口）。
 * content block 用 input_image / input_text；stream:false 让其返回完整 JSON。
 * 不传 reasoning —— 实测 CLIProxyAPI 转换层不会把 effort 真正透传给
 * grok，minimal/low 与默认的 reasoning tokens 基本相同，传了也无意义。
 */
function buildResponsesRequest(
  input: VisionInput,
  config: AppConfig,
): VisionRequest {
  return {
    url: `${config.J_SEE_BASE_URL}/v1/responses`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.J_SEE_TOKEN}`,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      model: config.J_SEE_MODEL,
      stream: false,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: `data:${input.mime};base64,${input.base64}`,
            },
            { type: "input_text", text: input.prompt },
          ],
        },
      ],
    }),
  };
}

/** OpenAI Chat Completions 请求（含 reasoning_effort） */
function buildOpenAIRequest(
  input: VisionInput,
  config: AppConfig,
): VisionRequest {
  return {
    url: `${config.J_SEE_BASE_URL}/v1/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.J_SEE_TOKEN}`,
      // CF bot 防护会拦截默认 UA（实测 urllib 的 Python-urllib 被 403）
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      model: config.J_SEE_MODEL,
      max_tokens: 2000,
      reasoning_effort: config.J_SEE_REASONING,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:${input.mime};base64,${input.base64}`,
              },
            },
            { type: "text", text: input.prompt },
          ],
        },
      ],
    }),
  };
}

/**
 * Anthropic Messages 请求。
 * 不传 reasoning_effort —— Anthropic 的 thinking（budget_tokens）语义/取值
 * 与 OpenAI 的 none|low|medium|high 不一一对应，不强行映射，保持默认（不开启 thinking）。
 */
function buildAnthropicRequest(
  input: VisionInput,
  config: AppConfig,
): VisionRequest {
  return {
    url: `${config.J_SEE_BASE_URL}/v1/messages`,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.J_SEE_TOKEN,
      "anthropic-version": ANTHROPIC_VERSION,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      model: config.J_SEE_MODEL,
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: input.mime,
                data: input.base64,
              },
            },
            { type: "text", text: input.prompt },
          ],
        },
      ],
    }),
  };
}

/** 按规范选择请求构造器 */
function buildRequest(
  input: VisionInput,
  config: AppConfig,
): VisionRequest {
  switch (config.J_SEE_API_SPEC) {
    case "responses":
      return buildResponsesRequest(input, config);
    case "anthropic":
      return buildAnthropicRequest(input, config);
    default:
      return buildOpenAIRequest(input, config);
  }
}

/** Responses 返回：output[] 找 type==="message"，拼接其 output_text block */
function parseResponsesContent(data: unknown): string {
  const output = (
    data as {
      output?: ReadonlyArray<{
        type?: string;
        content?: ReadonlyArray<{ type?: string; text?: unknown }>;
      }>;
    }
  )?.output;
  const msg = Array.isArray(output)
    ? output.find((o) => o?.type === "message")
    : undefined;
  const blocks = msg?.content;
  const text =
    Array.isArray(blocks) && blocks.length > 0
      ? blocks
          .filter((b) => b?.type === "output_text")
          .map((b) => String(b.text ?? ""))
          .join("")
      : "";
  if (text.length === 0) {
    throw new VisionError("视觉调用返回内容为空");
  }
  return text;
}

/** OpenAI Chat Completions 返回取 choices[0].message.content */
function parseOpenAIContent(data: unknown): string {
  const content = (
    data as {
      choices?: ReadonlyArray<{ message?: { content?: unknown } }>;
    }
  )?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new VisionError("视觉调用返回内容为空");
  }
  return content;
}

/** Anthropic 返回拼接所有 type==="text" 的 block */
function parseAnthropicContent(data: unknown): string {
  const blocks = (
    data as {
      content?: ReadonlyArray<{ type?: string; text?: unknown }>;
    }
  )?.content;
  const text =
    Array.isArray(blocks) && blocks.length > 0
      ? blocks
          .filter((b) => b?.type === "text")
          .map((b) => String(b.text ?? ""))
          .join("")
      : "";
  if (text.length === 0) {
    throw new VisionError("视觉调用返回内容为空");
  }
  return text;
}

/** 按规范选择响应解析器 */
function parseContent(data: unknown, config: AppConfig): string {
  switch (config.J_SEE_API_SPEC) {
    case "responses":
      return parseResponsesContent(data);
    case "anthropic":
      return parseAnthropicContent(data);
    default:
      return parseOpenAIContent(data);
  }
}

export async function callVision(
  input: VisionInput,
  config: AppConfig,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const req = buildRequest(input, config);

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.J_SEE_TIMEOUT_MS,
  );

  let resp: Response;
  try {
    resp = await fetchImpl(req.url, {
      method: "POST",
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new VisionError(`视觉调用超时（${config.J_SEE_TIMEOUT_MS}ms）`);
    }
    throw new VisionError(
      `视觉调用网络错误：${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    // responses 是默认规范，404 多半是代理不支持 /v1/responses。
    // 不静默降级（保持"失败原样上报"原则），但给出可操作的下一步提示
    const hint =
      config.J_SEE_API_SPEC === "responses" && resp.status === 404
        ? "（你的代理可能不支持 /v1/responses，可设置 J_SEE_API_SPEC=openai 改用 Chat Completions 格式）"
        : "";
    throw new VisionError(
      `视觉调用失败：HTTP ${resp.status}${hint}${
        text ? ` ${text.slice(0, 300)}` : ""
      }`,
      resp.status,
    );
  }

  let data: unknown;
  try {
    data = await resp.json();
  } catch (e) {
    throw new VisionError(
      `视觉调用返回非法 JSON：${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return parseContent(data, config);
}
