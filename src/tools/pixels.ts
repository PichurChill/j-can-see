/**
 * 本地像素工具（不调视觉模型）：crop / image_diff / colors。
 * 纯 jimp 操作，像素级精确，无需视觉配置。
 *
 * 核心原则：像素级事实（颜色/差异/尺寸）不信任视觉模型的文字描述，
 * 用这些本地工具取真值。
 */
import { z } from "zod";
import { ResizeStrategy } from "jimp";
import type { BaseConfig } from "../config.js";
import { decodeJimp, resolveRegion } from "../image.js";
import { readSource } from "../sources/index.js";
import { expandPath } from "../sources/file.js";
import {
  createColorClusters,
  hexToRgb,
  rgbToHex,
  linearColorDiff,
} from "./color.js";
import { writeOutput, deriveDefaultOutput, encodeForOutput } from "./output.js";
import {
  limitsOf,
  regionSchema,
  regionRequiredSchema,
  regionProperty,
  type ToolDeps,
  type LocalToolEntry,
} from "./types.js";

// ---------- crop ----------

export const cropSchema = z.object({
  source: z.string().min(1, "source 不能为空"),
  region: regionRequiredSchema,
  output: z.string().optional(),
  scale: z.number().positive().optional(),
});
export type CropArgs = z.infer<typeof cropSchema>;

export const CROP_TOOL: LocalToolEntry<CropArgs> = {
  tool: {
    name: "crop",
    description:
      "按坐标从图片裁剪区域并保存为文件（本地像素操作，不调视觉模型）。" +
      "常用于保存 locate/inspect 定位的区域供后续复用，或放大局部以便看清。" +
      "坐标用原图像素（轻微越界会自动收进图片边界），与 locate/inspect 输出直接对应。" +
      "省略 output 时要求 source 为本地文件路径（在源文件同目录生成 _crop.png）；URL/clipboard/latest 必须传 output。",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "图片来源（本地路径 / URL / latest / clipboard）",
        },
        region: regionProperty,
        output: {
          type: "string",
          description:
            "输出文件路径（支持 ~ 展开；按扩展名编码：.png → PNG，.jpg/.jpeg → JPEG）。URL/clipboard/latest 来源时必填",
        },
        scale: {
          type: "number",
          description: "放大倍数（如 4 = 放大 4 倍，BICUBIC），便于看清小图标",
        },
      },
      required: ["source", "region"],
    },
  },
  schema: cropSchema,
  needsVision: false,
  async run(
    args: CropArgs,
    config: BaseConfig,
    deps: ToolDeps = {},
  ): Promise<string> {
    // 输出路径决策放在读取之前：非文件 source 缺 output 时直接报错，
    // 不白做一次下载/剪贴板读取
    const outPath = args.output
      ? expandPath(args.output)
      : deriveDefaultOutput(args.source, "_crop", ".png");
    const raw = await readSource(args.source, deps.reader);
    const image = await decodeJimp(raw, limitsOf(config));
    const box = resolveRegion(args.region, image.width, image.height);
    image.crop({ x: box.x, y: box.y, w: box.w, h: box.h });
    if (args.scale) {
      image.scale({ f: args.scale, mode: ResizeStrategy.BICUBIC });
    }
    await writeOutput(outPath, await encodeForOutput(image, outPath));
    return `已裁剪并保存到 ${outPath}（${image.width}×${image.height}）`;
  },
};

// ---------- image_diff ----------

export const diffSchema = z.object({
  a: z.string().min(1, "a 不能为空"),
  b: z.string().min(1, "b 不能为空"),
  threshold: z.number().min(0).max(765).optional(),
});
export type DiffArgs = z.infer<typeof diffSchema>;

/** 默认像素差异阈值：三通道绝对差之和超过此值视为不同（黑白差=765） */
const DEFAULT_DIFF_THRESHOLD = 48;

/** 透明度容差：低于此值的 alpha 差异视为编码噪声 */
const ALPHA_TOLERANCE = 8;

/** 网格等分数（差异定位的粒度） */
const DIFF_GRID = 12;

interface DiffRegion {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly rate: number;
}

/**
 * 把 diff 像素按固定网格分块，返回 diff 密度最高的若干块。
 *
 * 注意这是**网格块**而非精确包围盒：相邻块不合并，一处横跨网格线的改动
 * 会报成 2-4 个块。用于粗定位「去哪儿看」，够用且可预期。
 */
function clusterDiffRegions(
  diffMap: Uint8Array,
  w: number,
  h: number,
  gridSize = DIFF_GRID,
): DiffRegion[] {
  const cellW = Math.max(1, Math.ceil(w / gridSize));
  const cellH = Math.max(1, Math.ceil(h / gridSize));
  const regions: DiffRegion[] = [];
  for (let cy = 0; cy < gridSize; cy++) {
    for (let cx = 0; cx < gridSize; cx++) {
      const x0 = cx * cellW;
      const y0 = cy * cellH;
      const x1m = Math.min(x0 + cellW, w);
      const y1m = Math.min(y0 + cellH, h);
      let diff = 0;
      let total = 0;
      for (let y = y0; y < y1m; y++) {
        for (let x = x0; x < x1m; x++) {
          total++;
          if (diffMap[y * w + x]) diff++;
        }
      }
      const rate = total > 0 ? diff / total : 0;
      if (rate > 0.1) {
        regions.push({ x1: x0, y1: y0, x2: x1m, y2: y1m, rate });
      }
    }
  }
  return regions.sort((p, q) => q.rate - p.rate).slice(0, 5);
}

export const IMAGE_DIFF_TOOL: LocalToolEntry<DiffArgs> = {
  tool: {
    name: "image_diff",
    description:
      "逐像素比较两张图片，返回总差异比例 + 差异密度最高的网格块坐标（本地操作，不调视觉模型）。" +
      "用于「写代码→截图→对比」循环定位变化，或对比设计稿与实现。返回的块坐标可喂给 see_image 的 region 查看具体变化。" +
      "含透明像素时：双方全透明的像素视为相同，透明度变化直接计为差异。",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "string", description: "第一张图片来源" },
        b: { type: "string", description: "第二张图片来源" },
        threshold: {
          type: "number",
          description:
            "像素差异阈值（三通道绝对差之和，0-765，默认 48）。越小越敏感",
        },
      },
      required: ["a", "b"],
    },
  },
  schema: diffSchema,
  needsVision: false,
  async run(
    args: DiffArgs,
    config: BaseConfig,
    deps: ToolDeps = {},
  ): Promise<string> {
    const threshold = args.threshold ?? DEFAULT_DIFF_THRESHOLD;
    const limits = limitsOf(config);
    const [bufA, bufB] = await Promise.all([
      readSource(args.a, deps.reader),
      readSource(args.b, deps.reader),
    ]);
    const imgA = await decodeJimp(bufA, limits);
    const imgB = await decodeJimp(bufB, limits);

    // 尺寸不一则以 A 为基准缩放 B，并向调用方披露（宽高比差异会计入差异）
    const sizeMismatch =
      imgA.width !== imgB.width || imgA.height !== imgB.height;
    const bSize = `${imgB.width}×${imgB.height}`;
    if (sizeMismatch) {
      imgB.resize({ w: imgA.width, h: imgA.height });
    }

    const dataA = imgA.bitmap.data;
    const dataB = imgB.bitmap.data;
    const total = imgA.width * imgA.height;
    const diffMap = new Uint8Array(total);
    let diffPixels = 0;
    for (let i = 0; i < total; i++) {
      const alphaA = dataA[i * 4 + 3];
      const alphaB = dataB[i * 4 + 3];
      // 双方全透明：RGB 通道是未定义值，视觉上相同
      if (alphaA === 0 && alphaB === 0) continue;
      // 透明度变化即视觉变化，与 RGB 阈值无关
      if (Math.abs(alphaA - alphaB) > ALPHA_TOLERANCE) {
        diffMap[i] = 1;
        diffPixels++;
        continue;
      }
      const d =
        Math.abs(dataA[i * 4] - dataB[i * 4]) +
        Math.abs(dataA[i * 4 + 1] - dataB[i * 4 + 1]) +
        Math.abs(dataA[i * 4 + 2] - dataB[i * 4 + 2]);
      if (d > threshold) {
        diffMap[i] = 1;
        diffPixels++;
      }
    }
    const pct = (diffPixels / total) * 100;
    const regions = clusterDiffRegions(diffMap, imgA.width, imgA.height);

    let out = `${
      sizeMismatch
        ? `注意：两图尺寸不同（A ${imgA.width}×${imgA.height}，B ${bSize}），B 已缩放对齐到 A 后比较，宽高比差异会计入差异。\n`
        : ""
    }差异比例：${pct.toFixed(2)}%（${diffPixels}/${total} 像素）`;
    if (regions.length > 0) {
      out +=
        `\n差异密度最高的网格块（${DIFF_GRID}×${DIFF_GRID} 等分，非精确包围盒；可喂给 see_image 的 region）：\n` +
        regions
          .map(
            (r, i) =>
              `${i + 1}. x1: ${r.x1}, y1: ${r.y1}, x2: ${r.x2}, y2: ${r.y2}（块内 ${(
                r.rate * 100
              ).toFixed(0)}% 不同）`,
          )
          .join("\n");
    } else {
      out += "\n无明显差异区域。";
    }
    return out;
  },
};

// ---------- colors ----------

export const colorsSchema = z.object({
  source: z.string().min(1, "source 不能为空"),
  region: regionSchema,
  top: z.number().int().positive().max(32).optional(),
  candidates: z.array(z.string()).min(1).optional(),
});
export type ColorsArgs = z.infer<typeof colorsSchema>;

export const COLORS_TOOL: LocalToolEntry<ColorsArgs> = {
  tool: {
    name: "colors",
    description:
      "分析图片主色，返回 top N 颜色（真实均值 hex + 占比，跳过完全透明像素）（本地操作，不调视觉模型）。" +
      "可传 candidates 候选色列表，返回与图像主色最接近的候选（精确色差计算，避免视觉模型对颜色的模糊描述）。" +
      "用于 UI 还原时取精确色值。" +
      "聚类按 5 位量化分桶（桶宽 8）：适合 UI 纯色；渐变或照片的主色会被打散成多个小簇，占比仅供参考。",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "图片来源" },
        region: regionProperty,
        top: {
          type: "number",
          description: "返回的主色数量（1-32，默认 5）",
        },
        candidates: {
          type: "array",
          items: { type: "string" },
          description:
            '候选色 hex 列表，如 ["#F9FAFA","#F5F5F5"]。返回与图像主色最接近的候选',
        },
      },
      required: ["source"],
    },
  },
  schema: colorsSchema,
  needsVision: false,
  async run(
    args: ColorsArgs,
    config: BaseConfig,
    deps: ToolDeps = {},
  ): Promise<string> {
    const raw = await readSource(args.source, deps.reader);
    const image = await decodeJimp(raw, limitsOf(config));
    if (args.region) {
      const box = resolveRegion(args.region, image.width, image.height);
      image.crop({ x: box.x, y: box.y, w: box.w, h: box.h });
    }

    const data = image.bitmap.data;
    const total = image.width * image.height;
    // 量化值仅作聚类键，输出取簇内真实颜色均值（见 createColorClusters）
    const clusters = createColorClusters();
    let opaque = 0;
    for (let i = 0; i < total; i++) {
      if (data[i * 4 + 3] === 0) continue;
      opaque++;
      clusters.add(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    }
    if (opaque === 0) {
      return "图片完全透明，没有不透明像素可分析。";
    }

    const topColors = clusters
      .result()
      .slice(0, args.top ?? 5)
      .map((c) => ({ ...c.rgb, pct: (c.count / opaque) * 100 }));

    let out = topColors
      .map(
        (c, i) => `${i + 1}. ${rgbToHex(c.r, c.g, c.b)}（${c.pct.toFixed(1)}%）`,
      )
      .join("\n");

    if (args.candidates?.length && topColors.length > 0) {
      const dom = topColors[0];
      let best = args.candidates[0];
      let bestDiff = Infinity;
      for (const cand of args.candidates) {
        // hexToRgb 校验失败抛 ImageError，绝不静默产出 NaN
        const rgb = hexToRgb(cand);
        const diff = linearColorDiff(dom, rgb);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = cand;
        }
      }
      out += `\n主色 ${rgbToHex(dom.r, dom.g, dom.b)} 最接近候选色 ${best}（色差 ${bestDiff.toFixed(0)}/255）`;
    }
    return out;
  },
};
