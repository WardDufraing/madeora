import { createLogger } from "@madeora/observability";
import { describe, expect, it } from "vitest";

import type { JobEnvelope } from "../definition.ts";
import { runJob } from "../executor.ts";
import { FakeObjects, fakeServices } from "../testing/fake-services.ts";
import { FakeJobStore } from "../testing/fake-store.ts";
import { homeCopyFiles } from "./home-copy.ts";

const CORRELATION = "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f";
const REQUEST = "5d2a7c41-8b3e-4f9a-a1c2-3e4f5a6b7c8d";
const SOURCE = `u/${"a".repeat(64)}`;
const SOURCE_THUMB = `u/${"b".repeat(64)}`;
const DEST = `h/${"c".repeat(64)}`;
const DEST_THUMB = `h/${"d".repeat(64)}`;

function setup(objects: FakeObjects | null = new FakeObjects()) {
  const lines: string[] = [];
  const logger = createLogger({ env: "test", sink: (_level, line) => lines.push(line) });
  const services = fakeServices({ objects });
  return { store: new FakeJobStore(), logger, lines, services, objects };
}

function envelope(): JobEnvelope {
  return {
    v: 1,
    correlationId: CORRELATION,
    idempotencyKey: `home-copy-files:${REQUEST}`,
    data: { requestId: REQUEST },
  };
}

describe("home-copy-files", () => {
  it("copies every object inside the bucket, checks sizes, then lets the database finish", async () => {
    const ctx = setup();
    ctx.objects?.objects.set(SOURCE, new Uint8Array([1, 2, 3]));
    ctx.objects?.objects.set(SOURCE_THUMB, new Uint8Array([4]));
    ctx.services.data.homeCopyBegin = {
      outcome: "ok",
      objects: [
        { from: SOURCE, to: DEST, size: 3 },
        { from: SOURCE_THUMB, to: DEST_THUMB, size: 1 },
      ],
    };
    await runJob(homeCopyFiles, envelope(), ctx);
    expect([...(ctx.objects?.objects.get(DEST) ?? [])]).toEqual([1, 2, 3]);
    expect([...(ctx.objects?.objects.get(DEST_THUMB) ?? [])]).toEqual([4]);
    // The source stays: the personal original keeps its own files.
    expect(ctx.objects?.objects.has(SOURCE)).toBe(true);
    expect(ctx.services.data.homeCopyFinishes).toEqual([
      { requestId: REQUEST, ok: true, code: null },
    ]);
    // Keys never reach the logs.
    expect(ctx.lines.join("\n")).not.toContain("a".repeat(64));
  });

  it("does nothing when the request has ended", async () => {
    const ctx = setup();
    await runJob(homeCopyFiles, envelope(), ctx);
    expect(ctx.services.data.homeCopyFinishes).toEqual([]);
  });

  it("fails the copy when a source object is missing or the copy has the wrong size", async () => {
    const missing = setup();
    missing.services.data.homeCopyBegin = {
      outcome: "ok",
      objects: [{ from: SOURCE, to: DEST, size: 3 }],
    };
    await runJob(homeCopyFiles, envelope(), missing).catch(() => undefined);
    expect(missing.services.data.homeCopyFinishes).toEqual([
      { requestId: REQUEST, ok: false, code: "source_missing" },
    ]);

    const wrong = setup();
    wrong.objects?.objects.set(SOURCE, new Uint8Array([1]));
    wrong.services.data.homeCopyBegin = {
      outcome: "ok",
      objects: [{ from: SOURCE, to: DEST, size: 3 }],
    };
    await runJob(homeCopyFiles, envelope(), wrong).catch(() => undefined);
    expect(wrong.services.data.homeCopyFinishes).toEqual([
      { requestId: REQUEST, ok: false, code: "copy_mismatch" },
    ]);
  });

  it("fails when storage is off, and refuses keys the database did not generate", async () => {
    const off = setup(null);
    off.services.data.homeCopyBegin = {
      outcome: "ok",
      objects: [{ from: SOURCE, to: DEST, size: 3 }],
    };
    await runJob(homeCopyFiles, envelope(), off).catch(() => undefined);
    expect(off.services.data.homeCopyFinishes).toEqual([
      { requestId: REQUEST, ok: false, code: "storage_not_configured" },
    ]);

    const forged = setup();
    forged.services.data.homeCopyBegin = {
      outcome: "ok",
      objects: [{ from: "../etc/passwd", to: DEST, size: 3 }],
    };
    await runJob(homeCopyFiles, envelope(), forged).catch(() => undefined);
    expect(forged.services.data.homeCopyFinishes).toEqual([
      { requestId: REQUEST, ok: false, code: "invalid_key" },
    ]);
  });

  it("retries a storage outage without finishing", async () => {
    const ctx = setup();
    if (ctx.objects) ctx.objects.down = true;
    ctx.services.data.homeCopyBegin = {
      outcome: "ok",
      objects: [{ from: SOURCE, to: DEST, size: 3 }],
    };
    await runJob(homeCopyFiles, envelope(), ctx).catch(() => undefined);
    expect(ctx.services.data.homeCopyFinishes).toEqual([]);
  });
});
