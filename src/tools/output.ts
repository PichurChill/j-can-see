/**
 * 本地工具的文件输出：路径推导 → 按扩展名编码 → 写盘。
 * crop / extract_fg / trace 共用（原先 writeOutput 在 pixels 与 vectorize 中逐字重复）。
 */
import fs from "node:fs/promises";
import { ImageError } from "../errors.js";
import type { DecodedImage } from "../image.js";
import { expandPath } from "../sources/file.js";
import { classifySource } from "../sources/index.js";

/** 写输出文件；目录不存在等 fs 错误包装为可读的 ImageError */
export async function writeOutput(
  path: string,
  data: Buffer | string,
): Promise<void> {
  try {
    await fs.writeFile(path, data);
  } catch (e) {
    throw new ImageError(
      `写入输出文件失败（目录不存在或无权限）：${path}：${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/**
 * 推导默认输出路径：源文件路径去扩展名 + 后缀，再过 expandPath
 *（支持 "~/x.png" → "$HOME/x_crop.png"，与读取侧的 ~ 展开对称）。
 *
 * 非本地文件来源（URL / clipboard / latest）没有可推导的输出位置：
 * 不允许默认输出（避免写出 "https:/..." 非法路径或污染进程 cwd），
 * 必须显式传 output。来源判定复用 classifySource，与 readSource 同一处真值。
 */
export function deriveDefaultOutput(
  source: string,
  suffix: string,
  ext: string,
): string {
  const kind = classifySource(source);
  if (kind !== "file") {
    const shown = kind === "url" ? "URL" : `"${source.trim()}"`;
    throw new ImageError(
      `source 为 ${shown} 时无法推导默认输出路径，必须显式指定 output 参数`,
    );
  }
  return expandPath(`${source.replace(/\.[^.]+$/, "")}${suffix}${ext}`);
}

/** 按输出扩展名选择编码：.jpg/.jpeg → JPEG(q90)，其余 → PNG */
export function encodeForOutput(
  image: DecodedImage,
  outPath: string,
): Promise<Buffer> {
  return /\.jpe?g$/i.test(outPath)
    ? image.getBuffer("image/jpeg", { quality: 90 })
    : image.getBuffer("image/png");
}
