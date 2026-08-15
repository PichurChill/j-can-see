/**
 * see_image 工具：读取图片 → 预处理 → 调视觉模型返回文字描述。
 *
 * 支持 region（先裁后看，局部放大）与多图对比（source 传数组）。
 * 现有 see_image({source, prompt}) 调用方式 100% 向后兼容。
 */
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { readSource } from "../sources/index.js";
import {
  processImage,
  cropAndProcess,
  type ProcessedImage,
} from "../image.js";
import { callVision } from "../vision.js";
import {
  limitsOf,
  sourceSchema,
  regionSchema,
  sourceProperty,
  regionProperty,
  type ToolDeps,
  type VisionToolEntry,
} from "./types.js";

export const DEFAULT_PROMPT =
  "详细描述这张图片的内容，包括其中的文字、UI 元素、颜色和布局。";

export const seeImageSchema = z
  .object({
    source: sourceSchema,
    prompt: z.string().optional(),
    region: regionSchema,
  })
  .refine((v) => !(v.region && v.source.length > 1), {
    message: "region 仅支持单图，多图对比时不能指定 region",
  });

export type SeeImageArgs = z.infer<typeof seeImageSchema>;

export const SEE_IMAGE_TOOL: VisionToolEntry<SeeImageArgs> = {
  tool: {
    name: "see_image",
    description:
      "读取图片（本地文件 / URL / 剪贴板 / 最近截图）并通过视觉模型返回文字描述。" +
      "用于主模型无多模态输入能力时的识图。支持多图对比（source 传数组），" +
      "支持 region 局部放大（先裁后看，常配合 locate/inspect 返回的坐标）。",
    inputSchema: {
      type: "object",
      properties: {
        source: sourceProperty,
        prompt: {
          type: "string",
          description:
            "对图片的提问或指令，省略则默认详细描述图片内容与其中文字。多图时用于描述对比/问答意图。",
        },
        region: regionProperty,
      },
      required: ["source"],
    },
  },
  schema: seeImageSchema,
  needsVision: true,
  async run(
    args: SeeImageArgs,
    config: AppConfig,
    deps: ToolDeps = {},
  ): Promise<string> {
    const limits = limitsOf(config);
    // source 经 schema transform 后必为数组，单值是长度 1 的特例
    const images: ProcessedImage[] = [];
    for (const src of args.source) {
      const raw = await readSource(src, deps.reader);
      images.push(
        args.region
          ? await cropAndProcess(raw, args.region, limits)
          : await processImage(raw, limits),
      );
    }

    return callVision(
      { images, prompt: args.prompt ?? DEFAULT_PROMPT },
      config,
      deps.fetchImpl,
    );
  },
};
