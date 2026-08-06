/**
 * 工具定义与编排：readSource → processImage → callVision。
 *
 * seeImage 纯函数编排，依赖（reader / fetchImpl）可注入，
 * 因此核心业务逻辑可脱离真实 IO 测试。
 */
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { FetchLike } from "./vision.js";
import {
  readSource,
  defaultReader,
  type SourceReader,
} from "./sources/index.js";
import { processImage } from "./image.js";
import { callVision } from "./vision.js";

export const DEFAULT_PROMPT =
  "详细描述这张图片的内容，包括其中的文字、UI 元素、颜色和布局。";

export const seeImageArgsSchema = z.object({
  source: z.string().min(1, "source 不能为空"),
  prompt: z.string().optional(),
});

export type SeeImageArgs = z.infer<typeof seeImageArgsSchema>;

/** MCP 工具声明：inputSchema 为标准 JSON Schema */
export const SEE_IMAGE_TOOL = {
  name: "see_image",
  description:
    "读取图片（本地文件 / URL / 剪贴板 / 最近截图）并通过视觉模型返回文字描述。" +
    "用于主模型无多模态输入能力时的识图。",
  inputSchema: {
    type: "object" as const,
    properties: {
      source: {
        type: "string",
        description:
          '图片来源：本地路径（支持 ~ 展开）、http(s) URL、"latest"（截图目录最新图）、"clipboard"（剪贴板，仅 mac/win）',
      },
      prompt: {
        type: "string",
        description:
          "对图片的提问或指令，省略则默认详细描述图片内容与其中文字",
      },
    },
    required: ["source"],
  },
};

export interface SeeImageDeps {
  readonly reader?: SourceReader;
  readonly fetchImpl?: FetchLike;
}

export async function seeImage(
  args: SeeImageArgs,
  config: AppConfig,
  deps: SeeImageDeps = {},
): Promise<string> {
  const raw = await readSource(args.source, deps.reader);
  const img = await processImage(
    raw,
    config.J_SEE_MAX_EDGE,
    config.J_SEE_MAX_BYTES,
  );
  return callVision(
    {
      base64: img.base64,
      mime: img.mime,
      prompt: args.prompt ?? DEFAULT_PROMPT,
    },
    config,
    deps.fetchImpl,
  );
}
