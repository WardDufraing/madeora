import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createJobRegistry, defineJob, DEFAULT_RETRY, jobEnvelopeSchema } from "./definition.ts";
import { classifyError, PermanentJobError, RetryableJobError, safeErrorCode } from "./errors.ts";
import { jobRegistry, jobs } from "./registry.ts";

const handle = () => Promise.resolve();
const payload = z.strictObject({ homeId: z.uuid() });

describe("defineJob", () => {
  it("fills in the default retry policy and lease", () => {
    const job = defineJob({ name: "send-thing", version: 1, payload, handle });
    expect(job.retry).toEqual(DEFAULT_RETRY);
    expect(job.leaseSeconds).toBe(300);
  });

  it.each(["SendThing", "send_thing", "send.thing", "-send", "send-", "a".repeat(65), ""])(
    "refuses the job name %j",
    (name) => {
      expect(() => defineJob({ name, version: 1, payload, handle })).toThrow(/Invalid job/);
    },
  );

  it.each([0, 1.5, 1001])("refuses version %s", (version) => {
    expect(() => defineJob({ name: "send-thing", version, payload, handle })).toThrow(/version/);
  });

  it("refuses a payload that accepts unknown keys, even through a cast", () => {
    const loose = z.object({ homeId: z.uuid() }) as unknown as typeof payload;
    const passthrough = z.looseObject({ homeId: z.uuid() }) as unknown as typeof payload;
    for (const schema of [loose, passthrough]) {
      expect(() => defineJob({ name: "send-thing", version: 1, payload: schema, handle })).toThrow(
        /must be strict/,
      );
    }
  });

  it.each([
    [{ maxAttempts: 0 }, /maxAttempts/],
    [{ maxAttempts: 11 }, /maxAttempts/],
    [{ minTimeoutMs: 10, maxTimeoutMs: 5 }, /timeouts/],
    [{ factor: 0.5 }, /factor/],
  ])("refuses the retry policy %j", (retry, message) => {
    expect(() => defineJob({ name: "send-thing", version: 1, payload, retry, handle })).toThrow(
      message,
    );
  });

  it.each([5, 3601, 12.5])("refuses a lease of %s seconds", (leaseSeconds) => {
    expect(() =>
      defineJob({ name: "send-thing", version: 1, payload, leaseSeconds, handle }),
    ).toThrow(/leaseSeconds/);
  });
});

describe("job registry", () => {
  it("refuses two jobs with one name", () => {
    const job = defineJob({ name: "send-thing", version: 1, payload, handle });
    expect(() => createJobRegistry([job, job])).toThrow(/Duplicate/);
  });

  it("knows every job, each with a strict payload", () => {
    expect([...jobRegistry.keys()]).toEqual(jobs.map((job) => job.name));
    for (const job of jobs) {
      const probe = job.payload.safeParse({ unexpectedKey: "x" });
      expect(probe.success).toBe(false);
    }
  });
});

describe("job envelope", () => {
  it("accepts a well-formed envelope", () => {
    expect(
      jobEnvelopeSchema.safeParse({
        v: 1,
        correlationId: "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f",
        idempotencyKey: "invitation:123:email",
        data: {},
      }).success,
    ).toBe(true);
  });
});

describe("errors", () => {
  it("keeps only safe codes", () => {
    expect(safeErrorCode("provider_unavailable")).toBe("provider_unavailable");
    expect(safeErrorCode("Failed for alice@example.com")).toBe("invalid_code");
    expect(new RetryableJobError("x y").code).toBe("invalid_code");
  });

  it("classifies errors", () => {
    expect(classifyError(new PermanentJobError("gone"))).toEqual({
      kind: "permanent",
      code: "gone",
    });
    expect(classifyError(new RetryableJobError("busy"))).toEqual({
      kind: "retryable",
      code: "busy",
    });
    expect(classifyError(new TypeError("boom"))).toEqual({
      kind: "retryable",
      code: "unexpected_error",
    });
    expect(classifyError("thrown string")).toEqual({ kind: "retryable", code: "unexpected_error" });
  });
});
