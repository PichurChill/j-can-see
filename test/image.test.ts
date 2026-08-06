import { describe, it, expect } from "vitest";
import { processImage } from "../src/image.js";
import { Jimp } from "jimp";

async function makePng(w: number, h: number, color = 0xff0000ff): Promise<Buffer> {
  const img = new Jimp({ width: w, height: h, color });
  return img.getBuffer("image/png");
}

describe("processImage", () => {
  it("小图不缩放，输出合法 JPEG base64", async () => {
    const raw = await makePng(100, 50);
    const out = await processImage(raw, 1568, 50 * 1024 * 1024);
    expect(out.mime).toBe("image/jpeg");
    expect(out.base64.length).toBeGreaterThan(0);
    const buf = Buffer.from(out.base64, "base64");
    // JPEG SOI magic bytes
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
  });

  it("大图等比缩放到长边上限，保持宽高比", async () => {
    const raw = await makePng(3000, 1500);
    const out = await processImage(raw, 1568, 50 * 1024 * 1024);
    const img = await Jimp.read(Buffer.from(out.base64, "base64"));
    expect(img.width).toBeLessThanOrEqual(1568);
    expect(img.height).toBeLessThanOrEqual(1568);
    // 原图 2:1，缩放后仍应约 2:1
    expect(Math.round(img.width / img.height)).toBe(2);
  });

  it("高度为长边时也正确缩放", async () => {
    const raw = await makePng(1000, 3000);
    const out = await processImage(raw, 1568, 50 * 1024 * 1024);
    const img = await Jimp.read(Buffer.from(out.base64, "base64"));
    expect(img.height).toBeLessThanOrEqual(1568);
  });

  it("超体积上限抛 ImageError", async () => {
    await expect(
      processImage(Buffer.alloc(100), 1568, 50),
    ).rejects.toMatchObject({ name: "ImageError" });
  });

  it("无法解码的字节抛 ImageError", async () => {
    await expect(
      processImage(
        Buffer.from("not an image"),
        1568,
        50 * 1024 * 1024,
      ),
    ).rejects.toMatchObject({ name: "ImageError" });
  });
});
