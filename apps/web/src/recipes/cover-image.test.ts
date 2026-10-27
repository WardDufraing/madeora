import sharp from "sharp";

import { COVER_MAX_SIDE, processCover } from "./cover-image";

async function photo(width: number, height: number): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } },
  })
    .jpeg()
    .withMetadata({
      orientation: 6,
      exif: { IFD0: { Make: "TestCam", Model: "Secret 1" }, IFD3: { GPSLatitudeRef: "N" } },
    })
    .toBuffer();
  return new Uint8Array(buffer);
}

describe("recipe covers", () => {
  it("re-encode as an upright WebP without metadata, scaled down to fit 1600 px", async () => {
    const result = await processCover(await photo(2400, 1200), "image/jpeg");
    if (!result.ok) throw new Error("expected a processed cover");
    expect(result.contentType).toBe("image/webp");
    const meta = await sharp(result.bytes).metadata();
    expect(meta.format).toBe("webp");
    // Orientation 6 turns the 2400×1200 photo upright (1200×2400) before scaling.
    expect(Math.max(meta.width, meta.height)).toBe(COVER_MAX_SIDE);
    expect(meta.height).toBeGreaterThan(meta.width);
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it("never scale a small photo up", async () => {
    const result = await processCover(await photo(40, 30), "image/jpeg");
    if (!result.ok) throw new Error("expected a processed cover");
    const meta = await sharp(result.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([30, 40]);
  });

  it("refuse bytes that are not the declared type, or not an image", async () => {
    expect(await processCover(await photo(40, 30), "image/png")).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(await processCover(new Uint8Array([0xff, 0xd8, 0xff, 0, 1, 2]), "image/jpeg")).toEqual({
      ok: false,
      reason: "invalid-image",
    });
  });
});
