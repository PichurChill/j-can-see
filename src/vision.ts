/**
 * 视觉调用：把 base64 图片交给 OpenAI 兼容的 /v1/chat/completions，
 * 返回模型的文本描述。
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

/** 仅声明我们关心的返回字段，其余忽略 */
interface VisionResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: unknown };
  }>;
}

export async function callVision(
  input: VisionInput,
  config: AppConfig,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const url = `${config.J_SEE_BASE_URL}/v1/chat/completions`;

  const body = {
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
  };

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.J_SEE_TIMEOUT_MS,
  );

  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.J_SEE_TOKEN}`,
        // CF bot 防护会拦截默认 UA（实测 urllib 的 Python-urllib 被 403）
        "User-Agent": "j-can-see/0.1 (mcp-vision-client)",
      },
      body: JSON.stringify(body),
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
    throw new VisionError(
      `视觉调用失败：HTTP ${resp.status}${
        text ? ` ${text.slice(0, 300)}` : ""
      }`,
      resp.status,
    );
  }

  let data: VisionResponse;
  try {
    data = (await resp.json()) as VisionResponse;
  } catch (e) {
    throw new VisionError(
      `视觉调用返回非法 JSON：${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new VisionError("视觉调用返回内容为空");
  }
  return content;
}
