import {
  attachmentAccept,
  attachmentDisplayName,
  attachmentIntentSchema,
  attachmentNameSchema,
  attachmentTypeOf,
} from "./attachment-policy";
import { checkAttachmentFile } from "./attachment-upload";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("attachment types", () => {
  it("takes the browser's type, or the extension when the browser gives none", () => {
    expect(attachmentTypeOf({ name: "a.png", type: "image/png" })).toBe("image/png");
    expect(attachmentTypeOf({ name: "Plan.DOCX", type: "" })).toBe(DOCX);
    expect(attachmentTypeOf({ name: "list.csv", type: "application/vnd.ms-excel" })).toBe(
      "text/csv",
    );
    expect(attachmentTypeOf({ name: "a.ods", type: "application/octet-stream" })).toBe(
      "application/vnd.oasis.opendocument.spreadsheet",
    );
  });

  it("refuses types outside the list, whatever the name says", () => {
    expect(attachmentTypeOf({ name: "photo.png", type: "image/svg+xml" })).toBeNull();
    expect(attachmentTypeOf({ name: "setup.exe", type: "" })).toBeNull();
    expect(attachmentTypeOf({ name: "page.html", type: "text/html" })).toBeNull();
    expect(attachmentTypeOf({ name: "old.doc", type: "application/msword" })).toBeNull();
  });

  it("checks the size before anything is sent", () => {
    expect(checkAttachmentFile({ name: "a.pdf", type: "application/pdf", size: 0 })).toEqual({
      problem: "size",
    });
    expect(
      checkAttachmentFile({ name: "a.pdf", type: "application/pdf", size: 10 * 1024 * 1024 + 1 }),
    ).toEqual({ problem: "size" });
    expect(
      checkAttachmentFile({ name: "a.pdf", type: "application/pdf", size: 10 * 1024 * 1024 }),
    ).toEqual({ type: "application/pdf" });
  });

  it("offers types and extensions to the file picker", () => {
    expect(attachmentAccept).toContain("application/pdf");
    expect(attachmentAccept).toContain(".docx");
    expect(attachmentAccept).not.toContain("svg");
  });
});

describe("attachmentDisplayName", () => {
  it("drops folders, invisible and direction characters, and extra spaces", () => {
    expect(attachmentDisplayName("C:\\Users\\sam\\Lease  2026.pdf", "application/pdf")).toBe(
      "Lease 2026.pdf",
    );
    expect(attachmentDisplayName("../../etc/passwd.txt", "text/plain")).toBe("passwd.txt");
    // A right-to-left override would show "fdp.exe" as "exe.pdf".
    expect(attachmentDisplayName("invoice\u202Efdp.exe.pdf", "application/pdf")).toBe(
      "invoicefdp.exe.pdf",
    );
    expect(attachmentDisplayName("a\u0000b\u200Bc.png", "image/png")).toBe("abc.png");
  });

  it("keeps the extension when it shortens a long name", () => {
    const name = attachmentDisplayName(
      `${"x".repeat(300)}.xlsx`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(Array.from(name)).toHaveLength(200);
    expect(name.endsWith(".xlsx")).toBe(true);
  });

  it("names a file with nothing visible after the type", () => {
    expect(attachmentDisplayName("\u200B\u202E", "image/jpeg")).toBe("file.jpg");
    expect(attachmentDisplayName("   ", "application/pdf")).toBe("file.pdf");
  });

  it("keeps names in any script, emoji included", () => {
    expect(attachmentDisplayName("Факту́ра 🧾.pdf", "application/pdf")).toBe("Факту́ра 🧾.pdf");
    expect(attachmentNameSchema.safeParse("Факту́ра 🧾.pdf").success).toBe(true);
  });
});

describe("attachmentIntentSchema", () => {
  const valid = {
    contentType: "application/pdf",
    size: 1000,
    name: "Lease.pdf",
    requestId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001",
  };

  it("accepts an allowed type, size and visible name", () => {
    expect(attachmentIntentSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ["an unlisted type", { contentType: "text/html" }],
    ["an empty file", { size: 0 }],
    ["more than 10 MB", { size: 10 * 1024 * 1024 + 1 }],
    ["a name with a direction override", { name: "a\u202Eb.pdf" }],
    ["a name with surrounding spaces", { name: " Lease.pdf" }],
    ["an empty name", { name: "" }],
    ["a name over 200 characters", { name: `${"a".repeat(197)}.pdf1` }],
    ["an unknown field", { path: "x" }],
  ])("refuses %s", (_label, change) => {
    expect(attachmentIntentSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });
});
