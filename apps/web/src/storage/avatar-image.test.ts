import sharp from "sharp";

import { AVATAR_SIZE, processAvatar, sniffImageType } from "./avatar-image";

async function image(
  format: "jpeg" | "png" | "webp",
  {
    width = 800,
    height = 600,
    exif = false,
    orientation,
  }: {
    width?: number;
    height?: number;
    exif?: boolean;
    orientation?: number;
  } = {},
): Promise<Uint8Array> {
  let pipeline = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } },
  }).toFormat(format);
  if (exif) {
    pipeline = pipeline.withExif({
      IFD0: { Make: "SecretCam", Model: "Spy 3000", Artist: "Ward at home" },
    });
  }
  if (orientation !== undefined) pipeline = pipeline.withMetadata({ orientation });
  return new Uint8Array(await pipeline.toBuffer());
}

describe("sniffImageType", () => {
  it("knows JPEG, PNG and WebP by their first bytes", async () => {
    expect(sniffImageType(await image("jpeg"))).toBe("image/jpeg");
    expect(sniffImageType(await image("png"))).toBe("image/png");
    expect(sniffImageType(await image("webp"))).toBe("image/webp");
  });

  it("does not recognise text, HTML, SVG or an empty file", () => {
    const text = (value: string) => new TextEncoder().encode(value);
    expect(sniffImageType(text("hello"))).toBeNull();
    expect(sniffImageType(text("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffImageType(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe("processAvatar", () => {
  it.each(["jpeg", "png", "webp"] as const)(
    "turns a %s into a 512×512 WebP with its SHA-256",
    async (format) => {
      const result = await processAvatar(await image(format), `image/${format}`);
      if (!result.ok) throw new Error(result.reason);
      expect(result.contentType).toBe("image/webp");
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      const meta = await sharp(result.bytes).metadata();
      expect(meta.format).toBe("webp");
      expect([meta.width, meta.height]).toEqual([AVATAR_SIZE, AVATAR_SIZE]);
    },
  );

  it("removes camera and personal details from the photo", async () => {
    const input = await image("jpeg", { exif: true });
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const result = await processAvatar(input, "image/jpeg");
    if (!result.ok) throw new Error(result.reason);
    const meta = await sharp(result.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(Buffer.from(result.bytes).includes("SecretCam")).toBe(false);
  });

  it("turns a photo upright by its orientation and drops the orientation tag", async () => {
    // Stored sideways (rotate 90°) and tall: upright it is wide. Either way the square is full.
    const input = await image("jpeg", { width: 300, height: 900, orientation: 6 });
    const result = await processAvatar(input, "image/jpeg");
    if (!result.ok) throw new Error(result.reason);
    const meta = await sharp(result.bytes).metadata();
    expect(meta.orientation).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([AVATAR_SIZE, AVATAR_SIZE]);
  });

  it("refuses bytes that are not the declared type, even if they are an image", async () => {
    expect(await processAvatar(await image("png"), "image/jpeg")).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("refuses a text file renamed to a picture", async () => {
    const renamed = new TextEncoder().encode("<?php system($_GET['x']); ?>");
    expect(await processAvatar(renamed, "image/png")).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses a truncated picture that only starts like a JPEG", async () => {
    const whole = await image("jpeg");
    const truncated = whole.slice(0, Math.floor(whole.byteLength / 3));
    expect(await processAvatar(truncated, "image/jpeg")).toEqual({
      ok: false,
      reason: "invalid-image",
    });
  });

  /** A valid PNG header claiming `width`×`height` pixels, with no real image data behind it. */
  function pngHeader(width: number, height: number): Uint8Array {
    const header = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write("IHDR", 12, "ascii");
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    header.writeUInt8(8, 24);
    header.writeUInt8(2, 25);
    return new Uint8Array(header);
  }

  it.each([
    ["400 megapixels", 20000, 20000],
    ["27 megapixels", 6000, 4500],
    ["a side longer than 8192", 9000, 10],
  ])("refuses a small file that claims %s without decoding it", async (_label, width, height) => {
    expect(await processAvatar(pngHeader(width, height), "image/png")).toEqual({
      ok: false,
      reason: "invalid-image",
    });
  });
});
