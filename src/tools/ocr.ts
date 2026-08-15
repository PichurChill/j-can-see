/**
 * ocr_long 工具：长截图 / 长页面 / 长聊天记录的分块 OCR。
 *
 * 策略：按 maxEdge 高度分块 + 重叠区（防止行被切断）→ 每块逐字 OCR →
 * 合并时按行去除重叠区的重复内容。
 *
 * 比一次性 OCR 整张超长图更可靠（避免服务端降采样丢字）。
 *
 * 去重是保守的：只在「相邻块首尾若干行完全一致」时才删，宁可漏删不误删。
 * 因此每条边界的处理结果都会如实报告 —— 漏删和误删两个方向的风险都要
 * 让调用方看得见（见 buildAudit）。
 */
import { z } from "zod";
import { Jimp } from "jimp";
import type { AppConfig } from "../config.js";
import { ImageError } from "../errors.js";
import { readSource } from "../sources/index.js";
import {
  decodeJimp,
  encodeProcessed,
  type DecodedImage,
  type ProcessedImage,
} from "../image.js";
import { callVision } from "../vision.js";
import {
  limitsOf,
  singleSourceSchema,
  singleSourceProperty,
  type ToolDeps,
  type VisionToolEntry,
} from "./types.js";

export const ocrLongSchema = z.object({
  source: singleSourceSchema,
  prompt: z.string().optional(),
});
export type OcrLongArgs = z.infer<typeof ocrLongSchema>;

/** 重叠区占块高的比例 */
const OVERLAP_RATIO = 0.12;

/** OCR 块的输出 token 上限：密集文字块 2000 会截断 */
const OCR_MAX_TOKENS = 8192;

/** 并发块数：压缩墙钟时间，又不至于打爆上游 rate limit */
const OCR_CONCURRENCY = 4;

/** 块数上限：超出则在切块前就 fail fast，而不是跑到一半让客户端超时 */
const OCR_MAX_CHUNKS = 16;

function ocrPrompt(extra?: string): string {
  const base =
    "逐字转录这张图片中的所有文字，严格保持原有的换行、缩进与结构。\n" +
    "如果有发言人、时间戳、引用、列表等格式，原样保留。\n" +
    "只输出转录的文字内容，不要添加解释、注释或多余说明。";
  return extra ? `${base}\n\n额外要求：${extra}` : base;
}

/** 归一化比较（忽略空白差异），保留原文输出 */
const norm = (s: string) => s.replace(/\s+/g, "");

interface MergeResult {
  readonly text: string;
  /** 本次去重删除的行（null = 未发生去重） */
  readonly removed: readonly string[] | null;
}

/**
 * 合并相邻两段文本：若前段尾部若干行 ≈ 后段头部（忽略空白差异），去重拼接。
 *
 * 匹配是精确的（仅忽略空白）—— 保守是刻意的：重叠区去重无法区分
 * 「同一行被转录两次」与「原文本就连续重复的行」，放宽匹配会引入误删。
 * 代价是行被切断导致两侧转录不一致时去重会失败，这种失败必须被如实报告。
 *
 * 导出供单测直接覆盖：并发下块的完成顺序不定，合并逻辑按纯函数测更精确。
 */
export function mergeTwo(prev: string, next: string): MergeResult {
  const aLines = prev.split("\n");
  const bLines = next.split("\n");
  const maxK = Math.min(aLines.length, bLines.length, 12);
  for (let k = maxK; k >= 1; k--) {
    const aTail = aLines.slice(-k).join("\n").trim();
    const bHead = bLines.slice(0, k).join("\n").trim();
    if (aTail && norm(aTail) === norm(bHead)) {
      return {
        text: [...aLines, ...bLines.slice(k)].join("\n"),
        removed: bLines.slice(0, k).map((l) => l.trim()),
      };
    }
  }
  return { text: `${prev}\n${next}`, removed: null };
}

interface Chunk {
  readonly y: number;
  readonly yEnd: number;
}

/** 计算分块的 y 区间列表。导出供单测覆盖（块数直接决定是否触发上限） */
export function planChunks(
  totalH: number,
  chunkH: number,
  overlap: number,
): Chunk[] {
  if (totalH <= chunkH) return [{ y: 0, yEnd: totalH }];
  const step = Math.max(1, chunkH - overlap);
  const chunks: Chunk[] = [];
  for (let y = 0; y < totalH; y += step) {
    const yEnd = Math.min(y + chunkH, totalH);
    chunks.push({ y, yEnd });
    if (yEnd >= totalH) break;
  }
  return chunks;
}

/**
 * 从已解码的整图按 y 区间取出一块，只分配块大小的 buffer。
 *
 * 不用 image.clone() + crop：那会为每块完整拷贝一次整图 bitmap
 *（长图可达数十 MB），随即又把其中绝大部分裁掉。
 *
 * 用 Jimp.fromBitmap 而非 new Jimp({data,...})：jimp 的 .d.ts 里构造签名的
 * 返回类型漏掉了插件方法（scaleToFit / crop 等只挂在 read()/fromBitmap() 的
 * 返回类型上），而块随后要交给 encodeProcessed 做缩放。fromBitmap 是
 * 「从裸 bitmap 建图」的正规入口，返回类型完整。
 */
function sliceBlock(image: DecodedImage, chunk: Chunk): DecodedImage {
  const w = image.width;
  const data = Buffer.from(
    image.bitmap.data.subarray(chunk.y * w * 4, chunk.yEnd * w * 4),
  );
  return Jimp.fromBitmap({ data, width: w, height: chunk.yEnd - chunk.y });
}

/**
 * 并发映射，保序返回。
 * 任一项失败立即向上抛 —— 不吞错、不用部分结果拼出「看起来完整」的输出。
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

interface Boundary {
  /** 边界位于块 index 与 index+1 之间（1-based 展示） */
  readonly index: number;
  readonly removed: readonly string[] | null;
  /** 该边界重叠区在原图中的 y 区间 */
  readonly overlapFrom: number;
  readonly overlapTo: number;
}

/**
 * 边界审计：每条边界都必须给出结论。
 *
 * 重叠区是本工具自己制造的，正常情况下必然有重复内容 ——
 * 「没检测到重叠」几乎总是意味着去重失败（模型两次转录不一致），
 * 绝不能陈述成一切正常。
 *
 * 导出供单测直接覆盖。
 */
export function buildAudit(
  boundaries: readonly Boundary[],
  overlap: number,
): string {
  if (boundaries.length === 0) return "";
  const lines = boundaries.map((b) => {
    const range = `原图 y ${b.overlapFrom}–${b.overlapTo}`;
    return b.removed
      ? `- 块${b.index}→块${b.index + 1}（${range}）：去除重复 ${
          b.removed.length
        } 行：${b.removed.map((l) => `「${l}」`).join("")}`
      : `- 块${b.index}→块${b.index + 1}（${range}）：⚠️ 未能识别重叠内容，此处可能残留重复文字`;
  });

  const failed = boundaries.filter((b) => !b.removed);
  const deduped = boundaries.filter((b) => b.removed);
  let note = `\n\n边界审计（重叠区约 ${overlap}px，去重仅在首尾行完全一致时执行）：\n${lines.join(
    "\n",
  )}`;
  if (failed.length > 0) {
    note +=
      `\n未识别重叠通常是该处有文字行被切断、两侧转录不一致所致 —— ` +
      `这些边界可能残留重复内容，可用 see_image 的 region 复核对应 y 区间。`;
  }
  if (deduped.length > 0) {
    note +=
      `\n已去重的行若在原文中本就连续重复（如聊天记录里的重复消息），` +
      `则属误删，同样可用 region 复核。`;
  }
  return note;
}

export const OCR_LONG_TOOL: VisionToolEntry<OcrLongArgs> = {
  tool: {
    name: "ocr_long",
    description:
      "对长截图 / 长页面 / 长聊天记录做分块 OCR 并合并（调视觉模型）。" +
      "自动按高度切块 + 重叠区防丢字，比一次性 OCR 超长图更可靠。" +
      "保留发言人/时间戳/引用等结构，输出纯文本。" +
      "多块时附每条边界的去重审计（含未能去重的边界与可复核坐标）。" +
      "短图（不超高）自动退化为单次 OCR。",
    inputSchema: {
      type: "object",
      properties: {
        source: singleSourceProperty,
        prompt: {
          type: "string",
          description: "可选额外指令，如「只转录中文部分」「忽略页眉页脚」",
        },
      },
      required: ["source"],
    },
  },
  schema: ocrLongSchema,
  needsVision: true,
  async run(
    args: OcrLongArgs,
    config: AppConfig,
    deps: ToolDeps = {},
  ): Promise<string> {
    const limits = limitsOf(config);
    const raw = await readSource(args.source, deps.reader);
    const image = await decodeJimp(raw, limits);
    const maxEdge = limits.maxEdge;
    const overlap = Math.floor(maxEdge * OVERLAP_RATIO);
    const chunks = planChunks(image.height, maxEdge, overlap);
    const prompt = ocrPrompt(args.prompt);

    if (chunks.length > OCR_MAX_CHUNKS) {
      throw new ImageError(
        `图片高 ${image.height}px 需切成 ${chunks.length} 块（上限 ${OCR_MAX_CHUNKS}），` +
          `逐块 OCR 的耗时会超出合理等待。请先用 crop 把图纵向切成几段，再分别 ocr_long。`,
      );
    }

    const ocrBlock = (img: ProcessedImage): Promise<string> =>
      callVision(
        { images: [img], prompt, maxTokens: OCR_MAX_TOKENS },
        config,
        deps.fetchImpl,
      );

    // 短图：单次 OCR（无需分块，也就没有边界与去重）
    if (chunks.length === 1) {
      return ocrBlock(await encodeProcessed(image, maxEdge));
    }

    const pieces = await mapWithConcurrency(
      chunks,
      OCR_CONCURRENCY,
      async (chunk) =>
        ocrBlock(await encodeProcessed(sliceBlock(image, chunk), maxEdge)),
    );

    // 合并并记录每条边界的处理结果
    let merged = pieces[0];
    const boundaries: Boundary[] = [];
    for (let i = 1; i < pieces.length; i++) {
      const r = mergeTwo(merged, pieces[i]);
      merged = r.text;
      boundaries.push({
        index: i,
        removed: r.removed,
        overlapFrom: chunks[i].y,
        overlapTo: chunks[i - 1].yEnd,
      });
    }

    const failed = boundaries.filter((b) => !b.removed).length;
    const header =
      `（分 ${pieces.length} 块 OCR，${boundaries.length} 条边界` +
      (failed > 0 ? `，其中 ${failed} 条未能自动去重）` : `，均已去重）`);
    return `${header}\n${merged}${buildAudit(boundaries, overlap)}`;
  },
};
