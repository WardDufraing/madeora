import sharp from "sharp";

import { checkAttachment, zipEntryNames } from "./attachment-file";

const encoder = new TextEncoder();

/** A minimal ZIP archive with stored (uncompressed) entries, like the first part of ODF files. */
function zip(entries: readonly { readonly name: string; readonly data: string }[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.data);
    const local = new Uint8Array(30 + name.length + data.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(8, 0, true); // stored
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ODT = "application/vnd.oasis.opendocument.text";

async function photoWithLocation(): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 80, b: 40 } },
  })
    .jpeg()
    .withMetadata({
      orientation: 6,
      exif: { IFD0: { Make: "TestCam", Model: "Secret 1" }, IFD3: { GPSLatitudeRef: "N" } },
    })
    .toBuffer();
  return new Uint8Array(buffer);
}

describe("checkAttachment", () => {
  it("re-encodes a photo in its own format, upright and without any metadata", async () => {
    const result = await checkAttachment(await photoWithLocation(), "image/jpeg");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contentType).toBe("image/jpeg");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    const meta = await sharp(result.bytes).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    // Orientation 6 was applied: the stored picture is portrait.
    expect([meta.width, meta.height]).toEqual([30, 40]);
    expect(Buffer.from(result.bytes).includes("TestCam")).toBe(false);
  });

  it("keeps PNG and WebP in their format", async () => {
    const png = await sharp({
      create: { width: 4, height: 4, channels: 4, background: "#00ff00" },
    })
      .png()
      .toBuffer();
    const checked = await checkAttachment(new Uint8Array(png), "image/png");
    expect(checked.ok && (await sharp(checked.bytes).metadata()).format).toBe("png");
    const webp = await sharp(png).webp().toBuffer();
    const checkedWebp = await checkAttachment(new Uint8Array(webp), "image/webp");
    expect(checkedWebp.ok && (await sharp(checkedWebp.bytes).metadata()).format).toBe("webp");
  });

  it("refuses an image that is another type than declared", async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000" } })
      .png()
      .toBuffer();
    expect(await checkAttachment(new Uint8Array(png), "image/jpeg")).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("refuses a truncated image and a pixel bomb without decoding it", async () => {
    const photo = await photoWithLocation();
    expect(await checkAttachment(photo.subarray(0, 200), "image/jpeg")).toEqual({
      ok: false,
      reason: "invalid-file",
    });
    const bomb = await sharp({
      create: { width: 7200, height: 7200, channels: 3, background: "#fff" },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(await checkAttachment(new Uint8Array(bomb), "image/png")).toEqual({
      ok: false,
      reason: "invalid-file",
    });
  });

  it("keeps a real PDF as uploaded and refuses a renamed executable", async () => {
    const pdf = encoder.encode("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n");
    const result = await checkAttachment(pdf, "application/pdf");
    expect(result).toMatchObject({ ok: true, contentType: "application/pdf" });
    expect(result.ok && result.bytes).toBe(pdf);
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    expect(await checkAttachment(exe, "application/pdf")).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("accepts UTF-8 text and CSV, and refuses NUL bytes or invalid UTF-8", async () => {
    expect((await checkAttachment(encoder.encode("naam;prijs\nkaas;€4\n"), "text/csv")).ok).toBe(
      true,
    );
    expect(await checkAttachment(new Uint8Array([0x61, 0x00, 0x62]), "text/plain")).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(await checkAttachment(new Uint8Array([0xc3, 0x28]), "text/plain")).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("accepts an Office file only with its package structure", async () => {
    const docx = zip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "word/document.xml", data: "<w:document/>" },
    ]);
    expect((await checkAttachment(docx, DOCX)).ok).toBe(true);
    // A Word package declared as a spreadsheet, and a plain ZIP, are refused.
    expect(await checkAttachment(docx, XLSX)).toEqual({ ok: false, reason: "mismatch" });
    const plain = zip([{ name: "readme.txt", data: "hi" }]);
    expect(await checkAttachment(plain, DOCX)).toEqual({ ok: false, reason: "mismatch" });
    expect(await checkAttachment(encoder.encode("PK\u0003\u0004garbage"), DOCX)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("accepts an OpenDocument file by its stored mimetype entry", async () => {
    const odt = zip([
      { name: "mimetype", data: ODT },
      { name: "content.xml", data: "<office:document-content/>" },
    ]);
    expect((await checkAttachment(odt, ODT)).ok).toBe(true);
    const wrong = zip([
      { name: "mimetype", data: "application/vnd.oasis.opendocument.spreadsheet" },
    ]);
    expect(await checkAttachment(wrong, ODT)).toEqual({ ok: false, reason: "mismatch" });
  });
});

describe("zipEntryNames", () => {
  it("lists entries from the central directory and refuses what is not a ZIP", () => {
    expect(
      zipEntryNames(
        zip([
          { name: "a.xml", data: "x" },
          { name: "b/c.xml", data: "" },
        ]),
      ),
    ).toEqual(["a.xml", "b/c.xml"]);
    expect(zipEntryNames(encoder.encode("%PDF-1.4"))).toBeNull();
  });
});
