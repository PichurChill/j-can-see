import { describe, it, expect, vi } from "vitest";
import { callVision, type FetchLike } from "../src/vision.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  J_SEE_TOKEN: "tok",
  J_SEE_BASE_URL: "https://example.com",
  J_SEE_MODEL: "grok-4.5",
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
});
