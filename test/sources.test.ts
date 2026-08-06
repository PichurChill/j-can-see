import { describe, it, expect } from "vitest";
import { readSource, type SourceReader } from "../src/sources/index.js";

interface FakeReader extends SourceReader {
  calls: string[];
}

function fakeReader(): FakeReader {
  const calls: string[] = [];
  const mk = (tag: string) => async (arg?: string) => {
    calls.push(`${tag}:${arg ?? ""}`);
    return Buffer.from(`${tag}:${arg ?? ""}`);
  };
  return {
    readFromFile: mk("file") as SourceReader["readFromFile"],
    readFromUrl: mk("url") as SourceReader["readFromUrl"],
    readClipboard: mk("clip") as SourceReader["readClipboard"],
    readLatestScreenshot: mk("latest") as SourceReader["readLatestScreenshot"],
    calls,
  };
}

describe("readSource 来源判定", () => {
  it("clipboard → 读剪贴板", async () => {
    const r = fakeReader();
    await readSource("clipboard", r);
    expect(r.calls).toEqual(["clip:"]);
  });

  it("latest → 读最近截图", async () => {
    const r = fakeReader();
    await readSource("latest", r);
    expect(r.calls).toEqual(["latest:"]);
  });

  it("http URL → 下载", async () => {
    const r = fakeReader();
    await readSource("http://x.com/a.png", r);
    expect(r.calls).toEqual(["url:http://x.com/a.png"]);
  });

  it("https URL → 下载", async () => {
    const r = fakeReader();
    await readSource("https://x.com/a.png", r);
    expect(r.calls).toEqual(["url:https://x.com/a.png"]);
  });

  it("本地路径 → 读文件（保留 ~ 原样传给 reader）", async () => {
    const r = fakeReader();
    await readSource("~/Desktop/x.png", r);
    expect(r.calls).toEqual(["file:~/Desktop/x.png"]);
  });

  it("trim 空白后判定", async () => {
    const r = fakeReader();
    await readSource("  clipboard  ", r);
    expect(r.calls).toEqual(["clip:"]);
  });

  it("空 source 抛 SourceError", async () => {
    await expect(readSource("   ", fakeReader())).rejects.toThrow(/为空/);
  });

  it("大写 URL 仍识别", async () => {
    const r = fakeReader();
    await readSource("HTTPS://x.com/a.png", r);
    expect(r.calls).toEqual(["url:HTTPS://x.com/a.png"]);
  });
});
