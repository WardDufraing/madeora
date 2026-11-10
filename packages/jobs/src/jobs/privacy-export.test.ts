import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

import { createLogger } from "@madeora/observability";
import { describe, expect, it } from "vitest";

import type { JobEnvelope } from "../definition.ts";
import { runJob } from "../executor.ts";
import { toCsv } from "../export/archive.ts";
import { buildZip } from "../export/zip.ts";
import { FakeObjects, fakeServices } from "../testing/fake-services.ts";
import { FakeJobStore } from "../testing/fake-store.ts";
import { EXPORT_MEDIA_BUDGET_BYTES, privacyExportBuild } from "./privacy-export.ts";

const CORRELATION = "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f";
const EXPORT = "5d2a7c41-8b3e-4f9a-a1c2-3e4f5a6b7c8d";
const ARCHIVE_KEY = `u/${"a".repeat(64)}`;
const PHOTO_KEY = `u/${"b".repeat(64)}`;
const BIG_KEY = `u/${"c".repeat(64)}`;
const PHOTO = "11111111-2222-4333-8444-555555555555";
const BIG = "66666666-7777-4888-8999-aaaaaaaaaaaa";

/** Reads a ZIP's entries (no data descriptors, no ZIP64: what buildZip writes). */
function readZip(bytes: Uint8Array): Map<string, Buffer> {
  const buffer = Buffer.from(bytes);
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extra = buffer.readUInt16LE(offset + 30);
    const comment = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    const localName = buffer.readUInt16LE(local + 26);
    const localExtra = buffer.readUInt16LE(local + 28);
    const start = local + 30 + localName + localExtra;
    const body = buffer.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(body) : Buffer.from(body));
    offset += 46 + nameLength + extra + comment;
  }
  return files;
}

function setup() {
  const lines: string[] = [];
  const logger = createLogger({ env: "test", sink: (_level, line) => lines.push(line) });
  const objects = new FakeObjects();
  const services = fakeServices({ objects });
  return { store: new FakeJobStore(), logger, lines, services, objects };
}

function envelope(): JobEnvelope {
  return {
    v: 1,
    correlationId: CORRELATION,
    idempotencyKey: `privacy-export:${EXPORT}`,
    data: { exportId: EXPORT },
  };
}

describe("buildZip", () => {
  it("writes an archive that common ZIP tools open", () => {
    const zip = buildZip(
      [
        { name: "manifest.json", data: new TextEncoder().encode('{"a":1}'), compress: true },
        { name: "tâches/notes.csv", data: new TextEncoder().encode("x,y\r\n"), compress: true },
        { name: "media/photos/a.bin", data: new Uint8Array([1, 2, 3]), compress: false },
      ],
      new Date("2026-11-10T12:00:00Z"),
    );
    const files = readZip(zip);
    expect(files.get("manifest.json")?.toString()).toBe('{"a":1}');
    expect(files.get("tâches/notes.csv")?.toString()).toBe("x,y\r\n");
    expect([...(files.get("media/photos/a.bin") ?? [])]).toEqual([1, 2, 3]);

    // `unzip -t` checks every CRC, where the tool exists.
    let unzip = true;
    try {
      execFileSync("unzip", ["-v"], { stdio: "ignore" });
    } catch {
      unzip = false;
    }
    if (unzip) {
      const dir = mkdtempSync(join(tmpdir(), "madeora-zip-"));
      try {
        writeFileSync(join(dir, "a.zip"), zip);
        expect(execFileSync("unzip", ["-t", join(dir, "a.zip")], { encoding: "utf8" })).toContain(
          "No errors detected",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("refuses unsafe or duplicate names", () => {
    const data = new Uint8Array();
    for (const name of ["../x", "/abs", "a/../b", "a\\b", "a/./b"]) {
      expect(() => buildZip([{ name, data, compress: false }], new Date())).toThrow(TypeError);
    }
    expect(() =>
      buildZip(
        [
          { name: "a", data, compress: false },
          { name: "a", data, compress: false },
        ],
        new Date(),
      ),
    ).toThrow(TypeError);
  });
});

describe("toCsv", () => {
  it("quotes, joins nested values as JSON and neutralises formulas", () => {
    const csv = toCsv([
      { title: 'Say "hi", ok', tags: ["a", "b"], formula: "=HYPERLINK(1)", n: 3, empty: null },
      { title: "line\nbreak", extra: "-1", points: -5 },
    ]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe("title,tags,formula,n,empty,extra,points");
    expect(lines[1]).toBe(`"Say ""hi"", ok","[""a"",""b""]",'=HYPERLINK(1),3,,,`);
    // Text that looks like a formula is neutralised; a negative number stays a number.
    expect(csv).toContain(`"line\nbreak",,,,,'-1,-5`);
  });
});

describe("privacy-export-build", () => {
  it("packs every category as JSON and CSV with a manifest, stores it and finishes", async () => {
    const ctx = setup();
    ctx.services.data.exportBegin = {
      outcome: "ok",
      objectKey: ARCHIVE_KEY,
      categories: ["tasks", "media"],
      allData: false,
      homes: [{ id: PHOTO, name: "Oak" }],
      kind: "personal",
    };
    ctx.services.data.exportCategories = {
      tasks: { files: { "tasks/tasks": [{ title: "Water the plants" }] }, media: [] },
      media: {
        files: { "media/photos": [{ id: PHOTO, file: PHOTO }] },
        media: [
          {
            fileId: PHOTO,
            path: `media/photos/${PHOTO}.webp`,
            objectKey: PHOTO_KEY,
            size: 4,
            contentType: "image/webp",
          },
        ],
      },
    };
    ctx.objects.objects.set(PHOTO_KEY, new Uint8Array([9, 8, 7, 6]));

    await runJob(privacyExportBuild, envelope(), ctx);

    const archive = ctx.objects.objects.get(ARCHIVE_KEY);
    expect(archive).toBeDefined();
    const files = readZip(archive ?? new Uint8Array());
    expect([...files.keys()].sort()).toEqual(
      [
        "README.txt",
        "manifest.json",
        "media/photos.csv",
        "media/photos.json",
        `media/photos/${PHOTO}.webp`,
        "tasks/tasks.csv",
        "tasks/tasks.json",
      ].sort(),
    );
    const manifest = JSON.parse(files.get("manifest.json")?.toString() ?? "{}") as {
      exportType: string;
      selection: string;
      homes: { id: string; name: string }[];
      complete: boolean;
      categories: { category: string; records: number }[];
    };
    expect(manifest.exportType).toBe("personal");
    expect(manifest.selection).toBe("chosen_categories");
    expect(manifest.homes).toEqual([{ id: PHOTO, name: "Oak" }]);
    expect(manifest.complete).toBe(true);
    expect(manifest.categories.map((c) => [c.category, c.records])).toEqual([
      ["tasks", 1],
      ["media", 1],
    ]);
    expect(ctx.services.data.exportFinishes).toEqual([
      {
        exportId: EXPORT,
        sizeBytes: archive?.byteLength,
        summary: { categories: { tasks: 1, media: 1 }, attachments: 1, omittedAttachments: 0 },
        partial: false,
      },
    ]);
    // Neither content nor keys reach the logs.
    const log = ctx.lines.join("\n");
    expect(log).not.toContain("Water the plants");
    expect(log).not.toContain(ARCHIVE_KEY);
    expect(log).not.toContain(PHOTO_KEY);
  });

  it("marks the export partial when attachments exceed the archive budget", async () => {
    const ctx = setup();
    ctx.services.data.exportBegin = {
      outcome: "ok",
      objectKey: ARCHIVE_KEY,
      categories: ["media"],
      allData: true,
      homes: [],
      kind: "personal",
    };
    ctx.services.data.exportCategories = {
      media: {
        files: { "media/photos": [] },
        media: [
          {
            fileId: BIG,
            path: `media/photos/${BIG}.jpg`,
            objectKey: BIG_KEY,
            size: EXPORT_MEDIA_BUDGET_BYTES + 1,
            contentType: "image/jpeg",
          },
        ],
      },
    };
    await runJob(privacyExportBuild, envelope(), ctx);
    const files = readZip(ctx.objects.objects.get(ARCHIVE_KEY) ?? new Uint8Array());
    const manifest = JSON.parse(files.get("manifest.json")?.toString() ?? "{}") as {
      complete: boolean;
      attachments: { omitted: { fileId: string; reason: string }[] };
    };
    expect(manifest.complete).toBe(false);
    expect(manifest.attachments.omitted).toEqual([{ fileId: BIG, reason: "archive_size_limit" }]);
    expect(ctx.services.data.exportFinishes[0]?.partial).toBe(true);
  });

  it("does nothing for an export that ended or changed before it started", async () => {
    const ctx = setup();
    ctx.services.data.exportBegin = { outcome: "invalidated" };
    await runJob(privacyExportBuild, envelope(), ctx);
    expect(ctx.objects.objects.size).toBe(0);
    expect(ctx.services.data.exportFinishes).toEqual([]);
  });

  it("stops without storing anything when the export ends while collecting", async () => {
    const ctx = setup();
    ctx.services.data.exportBegin = {
      outcome: "ok",
      objectKey: ARCHIVE_KEY,
      categories: ["account", "tasks"],
      allData: false,
      homes: [],
      kind: "personal",
    };
    ctx.services.data.exportCategories = { tasks: "gone" };
    await runJob(privacyExportBuild, envelope(), ctx);
    expect(ctx.objects.objects.size).toBe(0);
    expect(ctx.services.data.exportFinishes).toEqual([]);
  });

  it("fails the export when storage is off", async () => {
    const ctx = setup();
    const services = fakeServices({ objects: null });
    services.data.exportBegin = {
      outcome: "ok",
      objectKey: ARCHIVE_KEY,
      categories: ["account"],
      allData: false,
      homes: [],
      kind: "personal",
    };
    await runJob(privacyExportBuild, envelope(), { ...ctx, services }).catch(() => undefined);
    expect(services.data.exportFailures).toEqual([
      { exportId: EXPORT, code: "storage_not_configured" },
    ]);
  });

  it("fails on data it does not understand rather than packing it", async () => {
    const ctx = setup();
    ctx.services.data.exportBegin = {
      outcome: "ok",
      objectKey: ARCHIVE_KEY,
      categories: ["tasks"],
      allData: false,
      homes: [],
      kind: "personal",
    };
    ctx.services.data.exportCategories = { tasks: { files: { "../../etc": [] }, media: [] } };
    await runJob(privacyExportBuild, envelope(), ctx).catch(() => undefined);
    expect(ctx.services.data.exportFailures).toEqual([
      { exportId: EXPORT, code: "unexpected_data" },
    ]);
    expect(ctx.objects.objects.size).toBe(0);
  });

  it("retries a storage outage, then fails the export on the last attempt", async () => {
    const ctx = setup();
    ctx.objects.down = true;
    ctx.services.data.exportBegin = {
      outcome: "ok",
      objectKey: ARCHIVE_KEY,
      categories: ["account"],
      allData: false,
      homes: [],
      kind: "personal",
    };
    for (let run = 1; run <= 3; run += 1) {
      await runJob(privacyExportBuild, envelope(), ctx).catch(() => undefined);
      expect(ctx.services.data.exportFailures.length).toBe(run === 3 ? 1 : 0);
    }
    expect(ctx.services.data.exportFailures).toEqual([
      { exportId: EXPORT, code: "storage_unavailable" },
    ]);
  });

  it("packs a Home export with its own README and the Home in the manifest", async () => {
    const ctx = setup();
    ctx.services.data.exportBegin = {
      outcome: "ok",
      objectKey: ARCHIVE_KEY,
      categories: ["home", "tasks", "account"],
      allData: false,
      homes: [{ id: PHOTO, name: "Oak" }],
      kind: "home",
    };
    ctx.services.data.exportCategories = {
      home: { files: { "home/members": [{ name: "you", role: "owner" }] }, media: [] },
      tasks: { files: { "tasks/tasks": [{ title: "Water the plants" }] }, media: [] },
    };
    await runJob(privacyExportBuild, envelope(), ctx);
    const files = readZip(ctx.objects.objects.get(ARCHIVE_KEY) ?? new Uint8Array());
    const manifest = JSON.parse(files.get("manifest.json")?.toString() ?? "{}") as {
      exportType: string;
      homes: { id: string; name: string }[];
      categories: { category: string }[];
      exclusions: string[];
    };
    expect(manifest.exportType).toBe("home");
    expect(manifest.homes).toEqual([{ id: PHOTO, name: "Oak" }]);
    // A personal category never enters a Home export, whatever the row says.
    expect(manifest.categories.map((c) => c.category)).toEqual(["home", "tasks"]);
    expect(manifest.exclusions).toContain("personal_items_shared_into_the_home");
    expect(files.get("README.txt")?.toString()).toContain("Madeora Home data export");
    expect(files.has("home/members.csv")).toBe(true);
  });
});
