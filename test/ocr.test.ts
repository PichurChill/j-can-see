import { describe, it, expect } from "vitest";
import { Jimp } from "jimp";
import {
  OCR_LONG_TOOL,
  mergeTwo,
  planChunks,
  buildAudit,
} from "../src/tools/ocr.js";
import { runVision, makePng, readerOf, mockFetch } from "./helpers.js";

describe("mergeTwo", () => {
  it("尾部与头部完全一致时去重，并报告删除的行", () => {
    const r = mergeTwo("AAA\nBBB", "BBB\nCCC");
    expect(r.text).toBe("AAA\nBBB\nCCC");
    expect(r.removed).toEqual(["BBB"]);
  });

  it("多行重叠一并去重", () => {
    const r = mergeTwo("A\nB\nC", "B\nC\nD");
    expect(r.text).toBe("A\nB\nC\nD");
    expect(r.removed).toEqual(["B", "C"]);
  });

  it("仅空白差异仍能去重（模型对重叠区轻微改写）", () => {
    const r = mergeTwo("A\nB", "B  \n C");
    expect(r.removed).toEqual(["B"]);
    expect(r.text.split("\n").filter((l) => l.trim() === "B")).toHaveLength(1);
  });

  it("行被切断导致两侧转录不一致时不去重，removed 为 null", () => {
    // 这正是分块 OCR 的常态：块尾半行 vs 块首整行
    const r = mergeTwo("第一行\n第三行文字被切", "第三行文字被切断了\n第四行");
    expect(r.removed).toBeNull();
    // 内容原样保留（保守：宁可漏删也不误删）
    expect(r.text).toContain("第三行文字被切\n第三行文字被切断了");
  });
});

describe("planChunks", () => {
  it("短图不分块", () => {
    expect(planChunks(800, 1568, 188)).toEqual([{ y: 0, yEnd: 800 }]);
  });

  it("长图按 step = 块高 - 重叠 切分，末块贴底", () => {
    const chunks = planChunks(3136, 1568, 188);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ y: 0, yEnd: 1568 });
    expect(chunks[1].y).toBe(1380); // 1568 - 188
    expect(chunks[chunks.length - 1].yEnd).toBe(3136);
  });

  it("相邻块确实重叠（重叠区是刻意制造的）", () => {
    const chunks = planChunks(5000, 1568, 188);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].y).toBeLessThan(chunks[i - 1].yEnd);
    }
  });
});

describe("buildAudit", () => {
  const overlap = 188;

  it("去重成功的边界：列出删除的行 + 误删风险提示", () => {
    const out = buildAudit(
      [{ index: 1, removed: ["BBB"], overlapFrom: 1380, overlapTo: 1568 }],
      overlap,
    );
    expect(out).toContain("块1→块2");
    expect(out).toContain("「BBB」");
    expect(out).toContain("y 1380–1568");
    expect(out).toContain("误删");
  });

  it("去重失败的边界必须明确警告，且给出可复核坐标", () => {
    const out = buildAudit(
      [{ index: 1, removed: null, overlapFrom: 1380, overlapTo: 1568 }],
      overlap,
    );
    expect(out).toContain("未能识别重叠内容");
    expect(out).toContain("可能残留重复文字");
    expect(out).toContain("y 1380–1568");
    expect(out).toContain("region");
  });

  it("混合场景：成功与失败的边界各自如实呈现", () => {
    const out = buildAudit(
      [
        { index: 1, removed: null, overlapFrom: 1380, overlapTo: 1568 },
        { index: 2, removed: ["CCC"], overlapFrom: 2760, overlapTo: 2948 },
      ],
      overlap,
    );
    expect(out).toContain("块1→块2");
    expect(out).toContain("未能识别重叠内容");
    expect(out).toContain("块2→块3");
    expect(out).toContain("「CCC」");
    // 两个方向的风险都要披露
    expect(out).toContain("可能残留重复文字");
    expect(out).toContain("误删");
  });

  it("无边界（短图单块）时不产生审计段落", () => {
    expect(buildAudit([], overlap)).toBe("");
  });
});

describe("OCR_LONG_TOOL", () => {
  it("短图（高度未超限）退化为单次 OCR，无分块前缀与审计", async () => {
    const png = await makePng(100, 800, 0xffffffff);
    const f = mockFetch("短图文字内容");
    const text = await runVision(
      OCR_LONG_TOOL,
      { source: "x.png" },
      { reader: readerOf(png), fetchImpl: f },
    );
    expect(text).toBe("短图文字内容");
    expect(f.count()).toBe(1);
  });

  it("长图分块并发 OCR：块数正确，合并去重，附边界审计", async () => {
    // 高 3136 > maxEdge 1568 → 3 块。各块返回相同内容 → 断言与完成顺序无关
    const png = await makePng(100, 3136, 0xffffffff);
    const f = mockFetch("AAA\nBBB");
    const text = await runVision(
      OCR_LONG_TOOL,
      { source: "x.png" },
      { reader: readerOf(png), fetchImpl: f },
    );
    expect(f.count()).toBe(3);
    expect(text).toContain("分 3 块");
    expect(text).toContain("2 条边界");
    // 三块内容相同 → 两条边界都应去重，正文只留一份
    expect(text).toContain("均已去重");
    expect(text).not.toContain("AAA\nBBB\nAAA");
    expect(text).toContain("边界审计");
  });

  it("块宽超过 maxEdge 时会被缩放（覆盖 sliceBlock 产出物的缩放路径）", async () => {
    // 前一个用例的块是 100×1568，两边都不超 maxEdge，encodeProcessed 里的
    // scaleToFit 根本不会执行 —— 那条路径需要宽图才能覆盖到。
    // 2000×4000 → 3 块，每块 2000×1568，宽超限触发缩放
    const png = await makePng(2000, 4000, 0xffffffff);
    const f = mockFetch("文字");
    const text = await runVision(
      OCR_LONG_TOOL,
      { source: "x.png" },
      { reader: readerOf(png), fetchImpl: f },
    );
    expect(f.count()).toBe(3);
    expect(text).toContain("分 3 块");

    // 请求体里的图确实被缩到了长边上限内
    const body = JSON.parse(f.calls[0][1].body as string);
    const url: string = body.messages[0].content[0].image_url.url;
    const sent = await Jimp.read(Buffer.from(url.split(",")[1], "base64"));
    expect(sent.width).toBeLessThanOrEqual(1568);
    expect(sent.height).toBeLessThanOrEqual(1568);
  });

  it("块数超过上限时在发起 OCR 之前 fail fast", async () => {
    // 23000px 高 → 17 块 > 上限 16
    const png = await makePng(50, 23000, 0xffffffff);
    const f = mockFetch("不该被调用");
    await expect(
      runVision(
        OCR_LONG_TOOL,
        { source: "x.png" },
        { reader: readerOf(png), fetchImpl: f },
      ),
    ).rejects.toThrow(/需切成 17 块|上限 16/);
    // 一次视觉调用都不该发生
    expect(f.count()).toBe(0);
  });

  it("schema 拒绝数组 source（ocr_long 只支持单图）", () => {
    expect(
      OCR_LONG_TOOL.schema.safeParse({ source: ["a.png", "b.png"] }).success,
    ).toBe(false);
  });
});
