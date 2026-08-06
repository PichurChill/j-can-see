/**
 * 图片预处理：读取原始字节 → 等比缩放至长边上限 → 编码为 JPEG base64。
 *
 * 为什么压缩：1568px 是主流视觉模型的有效分辨率上限，再大也会被服务端
 * 降采样，识别效果不变但带宽与 token 明显下降。JPEG q90 对含文字截图
 * 足够（避免高压缩振铃影响 OCR），且体积远小于 PNG。
 */
import { Jimp } from "jimp";
import { ImageError } from "./errors.js";

export interface ProcessedImage {
  readonly base64: string;
  readonly mime: string;
}

/** 解码原始字节为 Jimp 实例；失败统一转 ImageError */
async function decodeImage(raw: Buffer) {
  try {
    return await Jimp.read(raw);
  } catch (e) {
    throw new ImageError(
      `无法解码图片（格式不支持或已损坏）：${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/**
 * @param raw      原始图片字节
 * @param maxEdge  长边像素上限
 * @param maxBytes 源文件体积上限，超出拒绝（防 jimp 解码爆内存）
 */
export async function processImage(
  raw: Buffer,
  maxEdge: number,
  maxBytes: number,
): Promise<ProcessedImage> {
  if (raw.byteLength > maxBytes) {
    throw new ImageError(
      `源文件 ${(raw.byteLength / 1024 / 1024).toFixed(1)}MB 超过上限 ${(
        maxBytes /
        1024 /
        1024
      ).toFixed(0)}MB`,
    );
  }

  const image = await decodeImage(raw);

  // 仅当超出上限时才缩放，避免无谓重编码放大体积
  if (image.width > maxEdge || image.height > maxEdge) {
    image.scaleToFit({ w: maxEdge, h: maxEdge });
  }

  const buf = await image.getBuffer("image/jpeg", { quality: 90 });
  return { base64: buf.toString("base64"), mime: "image/jpeg" };
}
