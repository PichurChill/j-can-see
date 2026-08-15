/**
 * inspect 工具：枚举图片中所有同类元素，返回编号列表 + 文字 + 坐标（原图坐标）。
 *
 * 用于盘点页面/界面布局，再配合 locate/see_image 做精确分析。
 */
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { readSource } from "../sources/index.js";
import { processImageWithScale } from "../image.js";
import { callVision } from "../vision.js";
import {
  extractBoxByLabel,
  toOriginal,
  clampBox,
  formatBox,
  type Box,
} from "./coords.js";
import {
  limitsOf,
  singleSourceSchema,
  singleSourceProperty,
  type ToolDeps,
  type VisionToolEntry,
} from "./types.js";

export const inspectSchema = z.object({
  source: singleSourceSchema,
  kind: z.string().optional(),
});

export type InspectArgs = z.infer<typeof inspectSchema>;

const DEFAULT_KIND =
  "UI 元素（按钮、链接、输入框、图标、标题、图片、徽章）";

/** 密集屏幕的元素列表输出较长，2000 会截断 */
const INSPECT_MAX_TOKENS = 8192;

interface InspectItem {
  readonly index: number;
  readonly label: string;
  readonly box: Box;
}

/**
 * 逐行解析模型返回的元素列表，坐标换算为原图坐标并 clamp 到图界。
 * 标签剥离只认带分隔符的坐标（"x1: 100"）—— "1920x1080" 这类正文不会被吃掉。
 */
function parseInspectLines(
  text: string,
  scale: number,
  originalWidth: number,
  originalHeight: number,
): InspectItem[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const items: InspectItem[] = [];
  for (const line of lines) {
    const box = extractBoxByLabel(line);
    if (!box) continue;
    // 文字：去掉坐标标签片段（前置非字符边界 + 后置非数字边界 + 强制分隔符，
    // "box1: 20" / "1920x1080" / "x1 20" 等正文不会被吃掉）+ 行首序号 / markdown 符号
    const label =
      line
        .replace(/(?<![\w])[xy][12](?!\d)\s*[:：,，]\s*-?\d+/gi, "")
        .replace(/^\s*[-*•]?\s*\d+\s*[.、)]?\s*/, "")
        .replace(/[,，\s]+/g, " ")
        .trim() || "(无文字)";
    items.push({
      index: items.length + 1,
      label,
      box: clampBox(
        toOriginal(box, scale),
        originalWidth,
        originalHeight,
      ),
    });
  }
  return items;
}

export const INSPECT_TOOL: VisionToolEntry<InspectArgs> = {
  tool: {
    name: "inspect",
    description:
      "枚举图片中所有同类元素，返回编号列表（含可见文字 + 原图像素坐标）。" +
      "用于盘点页面/界面布局（如「列出所有按钮」「列出所有输入框」）。" +
      "建议先 inspect 扫布局，再 locate 定位具体目标，最后 see_image 的 region 放大细节。" +
      "密集屏幕可缩小 kind 范围分多次调用。",
    inputSchema: {
      type: "object",
      properties: {
        source: singleSourceProperty,
        kind: {
          type: "string",
          description:
            '要枚举的元素类型，如 "buttons"（按钮）、"links"（链接）、"inputs"（输入框）、"icons"（图标）。省略则枚举所有常见 UI 元素。',
        },
      },
      required: ["source"],
    },
  },
  schema: inspectSchema,
  needsVision: true,
  async run(
    args: InspectArgs,
    config: AppConfig,
    deps: ToolDeps = {},
  ): Promise<string> {
    const raw = await readSource(args.source, deps.reader);
    const img = await processImageWithScale(raw, limitsOf(config));

    const kind = args.kind?.trim() || DEFAULT_KIND;
    const prompt =
      `找出图片中所有「${kind}」。\n` +
      "对每一个元素返回一行，格式严格为：\n" +
      "<序号>. <可见文字> x1: <n>, y1: <n>, x2: <n>, y2: <n>\n" +
      "坐标为图中像素（左上角为原点）。无文字的元素文字部分写「(无文字)」。\n" +
      "不要输出其他内容。";

    const text = await callVision(
      { images: [img], prompt, maxTokens: INSPECT_MAX_TOKENS },
      config,
      deps.fetchImpl,
    );

    const items = parseInspectLines(
      text,
      img.scale,
      img.originalWidth,
      img.originalHeight,
    );
    if (items.length === 0) {
      return `未检测到「${kind}」。模型返回原文：\n${text}`;
    }
    return items
      .map((i) => `${i.index}. ${i.label} ${formatBox(i.box)}`)
      .join("\n");
  },
};
