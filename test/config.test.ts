import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const BASE = {
  J_SEE_TOKEN: "tok_x",
  J_SEE_BASE_URL: "https://example.com",
  J_SEE_MODEL: "grok-4.5",
} as const;

describe("loadConfig", () => {
  it("应用默认值", () => {
    const c = loadConfig(BASE);
    expect(c.J_SEE_MODEL).toBe("grok-4.5");
    expect(c.J_SEE_API_SPEC).toBe("responses");
    expect(c.J_SEE_REASONING).toBe("none");
    expect(c.J_SEE_MAX_EDGE).toBe(1568);
    expect(c.J_SEE_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(c.J_SEE_TIMEOUT_MS).toBe(90000);
  });

  it("去除 BASE_URL 末尾斜杠", () => {
    expect(
      loadConfig({ ...BASE, J_SEE_BASE_URL: "https://x.com/" })
        .J_SEE_BASE_URL,
    ).toBe("https://x.com");
    expect(
      loadConfig({ ...BASE, J_SEE_BASE_URL: "https://x.com///" })
        .J_SEE_BASE_URL,
    ).toBe("https://x.com");
  });

  it("缺少 TOKEN 抛 ConfigError", () => {
    expect(() => loadConfig({ J_SEE_BASE_URL: "https://x.com" })).toThrow(
      /J_SEE_TOKEN/,
    );
  });

  it("缺少 BASE_URL 抛错", () => {
    expect(() => loadConfig({ J_SEE_TOKEN: "x" })).toThrow(/J_SEE_BASE_URL/);
  });

  it("缺少 MODEL 抛错", () => {
    expect(() =>
      loadConfig({ J_SEE_TOKEN: "x", J_SEE_BASE_URL: "https://x.com" }),
    ).toThrow(/J_SEE_MODEL/);
  });

  it("空字符串 MODEL 抛错", () => {
    expect(() => loadConfig({ ...BASE, J_SEE_MODEL: "" })).toThrow(
      /J_SEE_MODEL/,
    );
  });

  it("非法 URL 抛错", () => {
    expect(() =>
      loadConfig({ ...BASE, J_SEE_BASE_URL: "not-a-url" }),
    ).toThrow();
  });

  it("MAX_EDGE 字符串可 coerce 为数字", () => {
    expect(
      loadConfig({ ...BASE, J_SEE_MAX_EDGE: "800" }).J_SEE_MAX_EDGE,
    ).toBe(800);
  });

  it("REASONING 非法值抛错", () => {
    expect(() =>
      loadConfig({ ...BASE, J_SEE_REASONING: "turbo" }),
    ).toThrow();
  });

  it("API_SPEC 默认 responses，可显式设为 openai / anthropic", () => {
    expect(loadConfig(BASE).J_SEE_API_SPEC).toBe("responses");
    expect(
      loadConfig({ ...BASE, J_SEE_API_SPEC: "openai" }).J_SEE_API_SPEC,
    ).toBe("openai");
    expect(
      loadConfig({ ...BASE, J_SEE_API_SPEC: "anthropic" }).J_SEE_API_SPEC,
    ).toBe("anthropic");
  });

  it("API_SPEC 非法值抛错", () => {
    expect(() =>
      loadConfig({ ...BASE, J_SEE_API_SPEC: "gemini" }),
    ).toThrow();
  });
});
