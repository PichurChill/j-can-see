/**
 * locate 工具：在图片中定位单个目标，返回像素坐标（已换算为原图坐标）。
 *
 * 坐标系与 see_image/inspect 的 region 一致，
 * AI 可直接把返回坐标喂给 see_image --region 放大查看。
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

export const locateSchema = z.object({
  source: singleSourceSchema,
  target: z.string().min(1, "target 不能为空"),
});

export type LocateArgs = z.infer<typeof locateSchema>;

export const LOCATE_TOOL: VisionToolEntry<LocateArgs> = {
  tool: {
    name: "locate",
    description:
      "在图片中定位单个目标，返回其像素坐标（已换算为原图坐标，格式 x1,y1,x2,y2）。" +
      "用于 GUI 自动化（定位控件后操作）或粗到细分析（定位后用 see_image 的 region 放大查看）。" +
      "返回坐标可直接作为 see_image/crop 的 region 参数。",
    inputSchema: {
      type: "object",
      properties: {
        source: singleSourceProperty,
        target: {
          type: "string",
          description: "要定位的目标描述，如「发送按钮」「用户名输入框」「右上角的头像」",
        },
      },
      required: ["source", "target"],
    },
  },
  schema: locateSchema,
  needsVision: true,
  async run(
    args: LocateArgs,
    config: AppConfig,
    deps: ToolDeps = {},
  ): Promise<string> {
    const raw = await readSource(args.source, deps.reader);
    const img = await processImageWithScale(raw, limitsOf(config));

    const prompt =
      `在图片中定位「${args.target}」。\n` +
      "严格按以下格式返回一行（坐标为图中像素，左上角为原点）：\n" +
      "x1: <n>, y1: <n>, x2: <n>, y2: <n>\n" +
      "找不到则只返回：NOT_FOUND\n" +
      "不要输出任何其他内容。";

    const text = await callVision(
      { images: [img], prompt },
      config,
      deps.fetchImpl,
    );

    if (/NOT_FOUND/i.test(text.trim())) {
      return `未找到目标「${args.target}」。`;
    }

    // 按行提取坐标框：模型返回多个匹配时全部列出（静默取首个会误导 GUI 自动化）
    const toOrig = (b: Box) =>
      clampBox(
        toOriginal(b, img.scale),
        img.originalWidth,
        img.originalHeight,
      );
    const lineBoxes = text
      .split("\n")
      .map((l) => extractBoxByLabel(l.trim()))
      .filter((b): b is Box => b != null)
      .map(toOrig);
    const boxes =
      lineBoxes.length > 0
        ? lineBoxes
        : (() => {
            // 行级解析不到时退回整段解析（模型可能把坐标和说明写在同一行）
            const b = extractBoxByLabel(text);
            return b ? [toOrig(b)] : [];
          })();

    if (boxes.length === 0) {
      return `无法解析坐标，模型返回原文：\n${text}`;
    }
    if (boxes.length === 1) {
      return `找到「${args.target}」：${formatBox(boxes[0])}`;
    }
    return (
      `找到 ${boxes.length} 个「${args.target}」匹配（target 描述可能过于宽泛，` +
      `建议细化后重试；已全部列出）：\n` +
      boxes.map((b, i) => `${i + 1}. ${formatBox(b)}`).join("\n")
    );
  },
};
