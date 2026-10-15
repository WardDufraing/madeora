import { createLogger } from "@madeora/observability";
import { describe, expect, it } from "vitest";

import type { JobEnvelope } from "../definition.ts";
import { PermanentJobError, RetryableJobError } from "../errors.ts";
import { runJob } from "../executor.ts";
import { FakeObjects, fakeServices } from "../testing/fake-services.ts";
import { FakeJobStore } from "../testing/fake-store.ts";
import { storageFilePurge, storageObjectDelete, storageUploadExpire } from "./storage.ts";

const CORRELATION = "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f";
const FILE = "5d2a7c41-8b3e-4f9a-a1c2-3e4f5a6b7c8d";
const DELETION = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";
const KEY = `u/${"f".repeat(64)}`;

function setup(objects: FakeObjects | null = new FakeObjects()) {
  const lines: string[] = [];
  const logger = createLogger({ env: "test", sink: (_level, line) => lines.push(line) });
  return { store: new FakeJobStore(), logger, lines, services: fakeServices({ objects }) };
}

function envelope(data: Record<string, unknown>, idempotencyKey: string): JobEnvelope {
  return { v: 1, correlationId: CORRELATION, idempotencyKey, data };
}

describe("storage-upload-expire and storage-file-purge", () => {
  it("leave the decision to the database and log only the resulting status", async () => {
    const ctx = setup();
    await runJob(
      storageUploadExpire,
      envelope({ fileId: FILE }, `storage-file:${FILE}:expire`),
      ctx,
    );
    await runJob(storageFilePurge, envelope({ fileId: FILE }, `storage-file:${FILE}:purge:1`), ctx);
    expect(ctx.services.data.fileCalls).toEqual([
      { operation: "expire", fileId: FILE },
      { operation: "purge", fileId: FILE },
    ]);
    expect(ctx.lines.join("\n")).not.toContain(KEY);
  });

  it("retry when the database cannot be reached", async () => {
    const ctx = setup();
    ctx.services.data.unavailable = true;
    await expect(
      runJob(storageFilePurge, envelope({ fileId: FILE }, `storage-file:${FILE}:purge:2`), ctx),
    ).rejects.toThrow();
  });
});

describe("storage-object-delete", () => {
  const key = `storage-object:${DELETION}`;
  const run = (ctx: ReturnType<typeof setup>) =>
    runJob(storageObjectDelete, envelope({ deletionId: DELETION }, key), ctx);

  it("removes the object and marks the deletion done, without logging the key", async () => {
    const objects = new FakeObjects();
    objects.objects.set(KEY, new Uint8Array(10));
    const ctx = setup(objects);
    ctx.services.data.deletions.set(DELETION, { objectKey: KEY, done: false });
    await run(ctx);
    expect(objects.objects.has(KEY)).toBe(false);
    expect(ctx.services.data.deletions.get(DELETION)?.done).toBe(true);
    expect(ctx.lines.join("\n")).not.toContain(KEY);
  });

  it("does nothing more on a duplicate run, or when the deletion is gone or done", async () => {
    const objects = new FakeObjects();
    const ctx = setup(objects);
    ctx.services.data.deletions.set(DELETION, { objectKey: KEY, done: true });
    await run(ctx);
    expect(objects.deleted).toEqual([]);
    const other = setup(objects);
    await runJob(storageObjectDelete, envelope({ deletionId: DELETION }, `${key}:x`), other);
    expect(objects.deleted).toEqual([]);
  });

  it("retries during a storage outage and succeeds afterwards", async () => {
    const objects = new FakeObjects();
    objects.down = true;
    const ctx = setup(objects);
    ctx.services.data.deletions.set(DELETION, { objectKey: KEY, done: false });
    await expect(run(ctx)).rejects.toBeInstanceOf(RetryableJobError);
    expect(ctx.services.data.deletions.get(DELETION)?.done).toBe(false);
    objects.down = false;
    await run(ctx);
    expect(ctx.services.data.deletions.get(DELETION)?.done).toBe(true);
  });

  it("fails permanently where storage is off, and refuses a key Madeora did not generate", async () => {
    const off = setup(null);
    off.services.data.deletions.set(DELETION, { objectKey: KEY, done: false });
    await expect(run(off)).rejects.toBeInstanceOf(PermanentJobError);
    const forged = setup();
    forged.services.data.deletions.set(DELETION, { objectKey: "../../etc", done: false });
    await expect(run(forged)).rejects.toBeInstanceOf(PermanentJobError);
  });
});
