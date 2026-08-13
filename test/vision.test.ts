import { describe, it, expect, vi } from "vitest";
import { callVision, type FetchLike } from "../src/vision.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  J_SEE_TOKEN: "tok",
  J_SEE_BASE_URL: "https://example.com",
  J_SEE_MODEL: "grok-4.5",
  J_SEE_API_SPEC: "openai",
  J_SEE_REASONING: "none",
  J_SEE_MAX_EDGE: 1568,
  J_SEE_MAX_BYTES: 50 * 1024 * 1024,
  J_SEE_TIMEOUT_MS: 90000,
};

function mockFetch(opts: {
  ok: boolean;
  status?: number;
  body?: unknown;
  jsonError?: boolean;
}): FetchLike & { calls: [string, RequestInit][] } {
  const calls: [string, RequestInit][] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    return new Response(
      opts.jsonError ? "not-json" : JSON.stringify(opts.body ?? {}),
      {
        status: opts.ok ? 200 : (opts.status ?? 500),
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as unknown as FetchLike & { calls: [string, RequestInit][] };
  fn.calls = calls;
  return fn;
}

const INPUT = { base64: "AAA", mime: "image/jpeg", prompt: "描述" };

describe("callVision", () => {
  it("成功返回文本，请求带 UA + token + 正确 URL", async () => {
    const f = mockFetch({
      ok: true,
      body: { choices: [{ message: { content: "红色方块" } }] },
    });
    const text = await callVision(INPUT, config, f);
    expect(text).toBe("红色方块");

    const [url, init] = f.calls[0];
    expect(url).toBe("https://example.com/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/j-can-see/);
    expect(headers["Authorization"]).toBe("Bearer tok");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("grok-4.5");
    expect(body.reasoning_effort).toBe("none");
    expect(body.messages[0].content[0].type).toBe("image_url");
    expect(body.messages[0].content[1].text).toBe("描述");
  });

  it("401 抛 VisionError 且携带 status", async () => {
    const f = mockFetch({ ok: false, status: 401, body: { error: "bad key" } });
    await expect(callVision(INPUT, config, f)).rejects.toMatchObject({
      name: "VisionError",
      status: 401,
    });
  });

  it("429 抛 VisionError 且携带 status", async () => {
    const f = mockFetch({ ok: false, status: 429 });
    await expect(callVision(INPUT, config, f)).rejects.toMatchObject({
      status: 429,
    });
  });

  it("404 错误信息不含降级提示（提示仅限 responses 默认规范）", async () => {
    const f = mockFetch({ ok: false, status: 404 });
    const p = callVision(INPUT, config, f);
    await expect(p).rejects.toThrow(/HTTP 404/);
    await expect(p).rejects.not.toThrow(/J_SEE_API_SPEC=openai/);
  });

  it("返回空 content 抛错", async () => {
    const f = mockFetch({
      ok: true,
      body: { choices: [{ message: { content: "" } }] },
    });
    await expect(callVision(INPUT, config, f)).rejects.toThrow(/为空/);
  });

  it("content 缺失抛错", async () => {
    const f = mockFetch({ ok: true, body: { choices: [{}] } });
    await expect(callVision(INPUT, config, f)).rejects.toThrow(/为空/);
  });

  it("非 JSON 响应抛错", async () => {
    const f = mockFetch({ ok: true, jsonError: true });
    await expect(callVision(INPUT, config, f)).rejects.toThrow();
  });

  it("网络错误抛 VisionError", async () => {
    const f = (vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown) as FetchLike;
    await expect(callVision(INPUT, config, f)).rejects.toMatchObject({
      name: "VisionError",
    });
  });

  describe("anthropic 规范", () => {
    const anthropicConfig: AppConfig = {
      ...config,
      J_SEE_API_SPEC: "anthropic",
      J_SEE_MODEL: "claude-sonnet-4-5-20250929",
    };

    it("成功返回文本，请求走 /v1/messages + x-api-key", async () => {
      const f = mockFetch({
        ok: true,
        body: { content: [{ type: "text", text: "蓝色圆形" }] },
      });
      const text = await callVision(INPUT, anthropicConfig, f);
      expect(text).toBe("蓝色圆形");

      const [url, init] = f.calls[0];
      expect(url).toBe("https://example.com/v1/messages");
      const headers = init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("tok");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers["Authorization"]).toBeUndefined();
      expect(headers["User-Agent"]).toMatch(/j-can-see/);

      const body = JSON.parse(init.body as string);
      expect(body.model).toBe("claude-sonnet-4-5-20250929");
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.messages[0].content[0].type).toBe("image");
      expect(body.messages[0].content[0].source.type).toBe("base64");
      expect(body.messages[0].content[0].source.media_type).toBe("image/jpeg");
      expect(body.messages[0].content[1].text).toBe("描述");
    });

    it("401 抛 VisionError 且携带 status", async () => {
      const f = mockFetch({
        ok: false,
        status: 401,
        body: { error: "bad key" },
      });
      await expect(
        callVision(INPUT, anthropicConfig, f),
      ).rejects.toMatchObject({ name: "VisionError", status: 401 });
    });

    it("content 为空数组抛错", async () => {
      const f = mockFetch({ ok: true, body: { content: [] } });
      await expect(callVision(INPUT, anthropicConfig, f)).rejects.toThrow(
        /为空/,
      );
    });

    it("content 仅含非 text block 视为空", async () => {
      const f = mockFetch({
        ok: true,
        body: { content: [{ type: "tool_use", id: "x" }] },
      });
      await expect(callVision(INPUT, anthropicConfig, f)).rejects.toThrow(
        /为空/,
      );
    });
  });

  describe("responses 规范", () => {
    const responsesConfig: AppConfig = {
      ...config,
      J_SEE_API_SPEC: "responses",
    };

    it("成功返回文本，请求走 /v1/responses + input_image", async () => {
      const f = mockFetch({
        ok: true,
        body: {
          output: [
            { type: "reasoning", summary: [] },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "绿色三角" }],
            },
          ],
        },
      });
      const text = await callVision(INPUT, responsesConfig, f);
      expect(text).toBe("绿色三角");

      const [url, init] = f.calls[0];
      expect(url).toBe("https://example.com/v1/responses");
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer tok");
      expect(headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(init.body as string);
      expect(body.model).toBe("grok-4.5");
      expect(body.stream).toBe(false);
      expect(body.reasoning).toBeUndefined();
      expect(body.input[0].content[0].type).toBe("input_image");
      expect(body.input[0].content[0].image_url).toMatch(
        /^data:image\/jpeg;base64,/,
      );
      expect(body.input[0].content[1].type).toBe("input_text");
      expect(body.input[0].content[1].text).toBe("描述");
    });

    it("401 抛 VisionError 且携带 status", async () => {
      const f = mockFetch({
        ok: false,
        status: 401,
        body: { error: { message: "bad key" } },
      });
      await expect(
        callVision(INPUT, responsesConfig, f),
      ).rejects.toMatchObject({ name: "VisionError", status: 401 });
    });

    it("output 无 message block 视为空", async () => {
      const f = mockFetch({
        ok: true,
        body: { output: [{ type: "reasoning", summary: [] }] },
      });
      await expect(callVision(INPUT, responsesConfig, f)).rejects.toThrow(
        /为空/,
      );
    });

    it("message content 仅含非 output_text block 视为空", async () => {
      const f = mockFetch({
        ok: true,
        body: {
          output: [
            {
              type: "message",
              content: [{ type: "tool_call", name: "x" }],
            },
          ],
        },
      });
      await expect(callVision(INPUT, responsesConfig, f)).rejects.toThrow(
        /为空/,
      );
    });

    it("404 时错误信息提示改用 openai", async () => {
      const f = mockFetch({ ok: false, status: 404 });
      await expect(callVision(INPUT, responsesConfig, f)).rejects.toThrow(
        /J_SEE_API_SPEC=openai/,
      );
    });

    it("404 时仍携带 status 且不静默降级", async () => {
      const f = mockFetch({ ok: false, status: 404 });
      await expect(callVision(INPUT, responsesConfig, f)).rejects.toMatchObject(
        { name: "VisionError", status: 404 },
      );
    });
  });
});
