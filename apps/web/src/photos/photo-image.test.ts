import { readFileSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";

import { heicClaimedSize, processPhoto, sniffPhotoType } from "./photo-image";
import { PHOTO_LIMITS } from "./schema";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", name)));

async function image(
  format: "jpeg" | "png" | "webp" | "gif",
  {
    width = 800,
    height = 600,
    orientation,
  }: { width?: number; height?: number; orientation?: number } = {},
): Promise<Uint8Array> {
  let pipeline = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } },
  }).toFormat(format);
  if (orientation !== undefined) pipeline = pipeline.withMetadata({ orientation });
  return new Uint8Array(await pipeline.toBuffer());
}

describe("sniffPhotoType", () => {
  it("knows JPEG, PNG, WebP, GIF and HEIC by their first bytes", async () => {
    expect(sniffPhotoType(await image("jpeg"))).toBe("image/jpeg");
    expect(sniffPhotoType(await image("png"))).toBe("image/png");
    expect(sniffPhotoType(await image("webp"))).toBe("image/webp");
    expect(sniffPhotoType(await image("gif"))).toBe("image/gif");
    expect(sniffPhotoType(fixture("landscape.heic"))).toBe("image/heic");
  });

  it("does not recognise text, HTML, SVG, an MP4 or an empty file", () => {
    const text = (value: string) => new TextEncoder().encode(value);
    expect(sniffPhotoType(text("hello"))).toBeNull();
    expect(sniffPhotoType(text("<html></html>"))).toBeNull();
    expect(sniffPhotoType(text("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffPhotoType(text("\0\0\0\u0018ftypmp42\0\0\0\0"))).toBeNull();
    expect(sniffPhotoType(new Uint8Array())).toBeNull();
  });
});

describe("processPhoto", () => {
  it("makes an optimized master and three derivatives, all WebP, never larger than asked", async () => {
    const result = await processPhoto(
      await image("jpeg", { width: 4000, height: 3000 }),
      "image/jpeg",
    );
    if (!result.ok) throw new Error("expected a photo");
    expect(result.variants.map((variant) => variant.kind)).toEqual([
      "master",
      "full",
      "display",
      "thumb",
    ]);
    const sides = result.variants.map((variant) => Math.max(variant.width, variant.height));
    expect(sides).toEqual([
      PHOTO_LIMITS.masterSide,
      PHOTO_LIMITS.fullSide,
      PHOTO_LIMITS.displaySide,
      PHOTO_LIMITS.thumbSide,
    ]);
    for (const variant of result.variants) {
      const meta = await sharp(variant.bytes).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.width).toBe(variant.width);
      expect(variant.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("never enlarges a small picture", async () => {
    const result = await processPhoto(await image("png", { width: 200, height: 100 }), "image/png");
    if (!result.ok) throw new Error("expected a photo");
    expect(
      result.variants.every((variant) => variant.width === 200 && variant.height === 100),
    ).toBe(true);
  });

  it("turns a picture upright by its EXIF orientation", async () => {
    // Stored 800x600 with orientation 6 (rotate 90° clockwise): it must come out 600 wide, 800 tall.
    const result = await processPhoto(await image("jpeg", { orientation: 6 }), "image/jpeg");
    if (!result.ok) throw new Error("expected a photo");
    expect(result.variants[0]).toMatchObject({ width: 600, height: 800 });
  });

  it("drops every piece of metadata (camera, GPS, time)", async () => {
    const withExif = new Uint8Array(
      await sharp({ create: { width: 64, height: 64, channels: 3, background: "#123456" } })
        .jpeg()
        .withExif({ IFD0: { Make: "SecretCam", Artist: "Ward at home" } })
        .toBuffer(),
    );
    expect(Buffer.from(withExif).includes("SecretCam")).toBe(true);
    const result = await processPhoto(withExif, "image/jpeg");
    if (!result.ok) throw new Error("expected a photo");
    for (const variant of result.variants) {
      expect(Buffer.from(variant.bytes).includes("SecretCam")).toBe(false);
      expect((await sharp(variant.bytes).metadata()).exif).toBeUndefined();
    }
  });

  it("decodes a HEIC picture", async () => {
    const result = await processPhoto(fixture("landscape.heic"), "image/heic");
    if (!result.ok) throw new Error("expected a photo");
    expect(result.variants[0]).toMatchObject({ width: 64, height: 32 });
    const { data } = await sharp(result.variants[0]?.bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // The left half was painted blue and the right half red in the source.
    expect(data[2]).toBeGreaterThan(data[0] ?? 0);
    const last = data.length - 4;
    expect(data[last] ?? 0).toBeGreaterThan(data[last + 2] ?? 255);
  });

  it("accepts a HEIC file declared as HEIF, and a HEIC with EXIF data", async () => {
    expect((await processPhoto(fixture("landscape.heic"), "image/heif")).ok).toBe(true);
    const result = await processPhoto(fixture("with-exif.heic"), "image/heic");
    if (!result.ok) throw new Error("expected a photo");
    for (const variant of result.variants) {
      expect(Buffer.from(variant.bytes).includes("CamCo")).toBe(false);
    }
  });

  it("keeps the first frame of a GIF", async () => {
    const result = await processPhoto(await image("gif", { width: 90, height: 60 }), "image/gif");
    if (!result.ok) throw new Error("expected a photo");
    expect(result.variants[0]).toMatchObject({ width: 90, height: 60 });
  });

  it("refuses a file that is not what it says it is", async () => {
    expect(await processPhoto(await image("png"), "image/jpeg")).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(await processPhoto(new TextEncoder().encode("not an image"), "image/png")).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(await processPhoto(fixture("landscape.heic"), "image/png")).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("refuses corrupt files", async () => {
    const jpeg = await image("jpeg");
    expect(await processPhoto(jpeg.slice(0, 200), "image/jpeg")).toEqual({
      ok: false,
      reason: "invalid-image",
    });
    const heic = fixture("landscape.heic");
    expect(await processPhoto(heic.slice(0, 120), "image/heic")).toEqual({
      ok: false,
      reason: "invalid-image",
    });
    const header = new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66,
      0x31,
    ]);
    expect(await processPhoto(header, "image/heic")).toEqual({
      ok: false,
      reason: "invalid-image",
    });
  });

  it("refuses a picture whose header claims too many pixels before decoding it", async () => {
    // 12001 pixels wide is over the side limit; a one-pixel-tall PNG keeps the file tiny.
    const wide = await image("png", { width: PHOTO_LIMITS.maxSide + 1, height: 1 });
    expect(await processPhoto(wide, "image/png")).toEqual({ ok: false, reason: "invalid-image" });
  });
});

describe("heicClaimedSize", () => {
  it("reads the size the file claims, and nothing from a file without one", () => {
    // The coded size may be larger than the picture (it is padded to the encoder's blocks).
    const claimed = heicClaimedSize(fixture("landscape.heic"));
    expect(claimed?.width).toBeGreaterThanOrEqual(64);
    expect(claimed?.height).toBeGreaterThanOrEqual(32);
    expect(heicClaimedSize(new TextEncoder().encode("no boxes here"))).toBeNull();
  });
});
