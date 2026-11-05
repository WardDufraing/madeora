import { checkPhotoFile, photoTypeOf } from "./upload";

const file = (name: string, type: string, size = 1000) => ({ name, type, size });

describe("photoTypeOf", () => {
  it("accepts the supported types", () => {
    for (const type of [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
      "image/gif",
    ]) {
      expect(photoTypeOf(file("x", type))).toBe(type);
    }
  });

  it("falls back to the extension for HEIC, which browsers often send without a type", () => {
    expect(photoTypeOf(file("IMG_0001.HEIC", ""))).toBe("image/heic");
    expect(photoTypeOf(file("IMG_0001.heif", "application/octet-stream"))).toBe("image/heif");
  });

  it("does not trust the extension over a real, different type", () => {
    expect(photoTypeOf(file("photo.heic", "application/pdf"))).toBeNull();
    expect(photoTypeOf(file("notes.txt", ""))).toBeNull();
    expect(photoTypeOf(file("vector.svg", "image/svg+xml"))).toBeNull();
  });
});

describe("checkPhotoFile", () => {
  it("checks type and size before anything is sent", () => {
    expect(checkPhotoFile(file("a.jpg", "image/jpeg"))).toEqual({ type: "image/jpeg" });
    expect(checkPhotoFile(file("a.pdf", "application/pdf"))).toEqual({ problem: "type" });
    expect(checkPhotoFile(file("a.jpg", "image/jpeg", 0))).toEqual({ problem: "size" });
    expect(checkPhotoFile(file("a.jpg", "image/jpeg", 25 * 1024 * 1024 + 1))).toEqual({
      problem: "size",
    });
    expect(checkPhotoFile(file("a.jpg", "image/jpeg", 25 * 1024 * 1024))).toEqual({
      type: "image/jpeg",
    });
  });
});
