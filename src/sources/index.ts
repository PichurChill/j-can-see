/**
 * 来源编排：根据 source 字符串判定类型并读取字节。
 *
 * 判定顺序：
 *  - "clipboard"  → 系统剪贴板（mac/win）
 *  - "latest"     → 截图目录中最新图片
 *  - http(s) URL  → 下载
 *  - 其他         → 本地文件路径（支持 ~）
 *
 * reader 可注入：判定逻辑（本文件的核心）可用 fake reader 纯单测，
 * 真实 IO 实现各自独立测试。
 */
import { SourceError } from "../errors.js";
import { readFromFile } from "./file.js";
import { readFromUrl } from "./url.js";
import { readClipboard } from "./clipboard.js";
import { readLatestScreenshot } from "./latest.js";

export interface SourceReader {
  readonly readFromFile: (input: string) => Promise<Buffer>;
  readonly readFromUrl: (url: string) => Promise<Buffer>;
  readonly readClipboard: () => Promise<Buffer>;
  readonly readLatestScreenshot: () => Promise<Buffer>;
}

export const defaultReader: SourceReader = {
  readFromFile,
  readFromUrl,
  readClipboard,
  readLatestScreenshot,
};

export async function readSource(
  source: string,
  reader: SourceReader = defaultReader,
): Promise<Buffer> {
  const s = source.trim();
  if (!s) throw new SourceError("source 为空");

  if (s === "clipboard") return reader.readClipboard();
  if (s === "latest") return reader.readLatestScreenshot();
  if (/^https?:\/\//i.test(s)) return reader.readFromUrl(s);
  return reader.readFromFile(s);
}
