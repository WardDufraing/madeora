import { describe, expect, it } from "vitest";

import {
  createSupabaseJobStore,
  JobStoreError,
  type JobsSupabaseClient,
} from "./supabase-store.ts";

type RpcResult = { data: unknown; error: { code: string; message: string } | null };

/** Records rpc calls and answers each function name with a scripted result. */
function fakeClient(results: Record<string, RpcResult>) {
  const calls: { fn: string; args: unknown }[] = [];
  const client = {
    rpc: (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return Promise.resolve(
        results[fn] ?? { data: null, error: { code: "PGRST202", message: "" } },
      );
    },
  } as unknown as JobsSupabaseClient;
  return { client, calls };
}

const ok = (data: unknown): RpcResult => ({ data, error: null });

describe("Supabase job store", () => {
  it("claims rows and maps them", async () => {
    const { client, calls } = fakeClient({
      claim_job_outbox: ok([
        {
          id: "r1",
          job_name: "sample-ping",
          job_version: 1,
          idempotency_key: "k",
          payload: { label: "x" },
          correlation_id: "c",
          attempts: 2,
          generation: 1,
        },
        {
          id: "r2",
          job_name: "sample-ping",
          job_version: 1,
          idempotency_key: "k2",
          payload: [1],
          correlation_id: "c",
          attempts: 1,
          generation: 0,
        },
      ]),
    });
    const rows = await createSupabaseJobStore(client).claim(25, 120);
    expect(calls).toEqual([
      { fn: "claim_job_outbox", args: { p_limit: 25, p_lease_seconds: 120 } },
    ]);
    expect(rows[0]).toEqual({
      id: "r1",
      jobName: "sample-ping",
      jobVersion: 1,
      idempotencyKey: "k",
      payload: { label: "x" },
      correlationId: "c",
      attempts: 2,
      generation: 1,
    });
    expect(rows[1]?.payload).toEqual({});
  });

  it("passes complete, fail and release through", async () => {
    const { client, calls } = fakeClient({
      complete_job_outbox: ok(true),
      fail_job_outbox: ok("dead"),
      release_job_outbox: ok(2),
    });
    const store = createSupabaseJobStore(client);
    expect(await store.complete("r1", "run_1")).toBe(true);
    expect(await store.fail("r1", "trigger_unavailable", false)).toBe("dead");
    expect(await store.release(["a", "b"])).toBe(2);
    expect(calls.map((call) => call.args)).toEqual([
      { p_id: "r1", p_run_id: "run_1" },
      { p_id: "r1", p_error_code: "trigger_unavailable", p_permanent: false },
      { p_ids: ["a", "b"] },
    ]);
  });

  it.each([
    [
      [{ state: "claimed", claim_token: "t", attempt: 2, lease_until: "2026-10-15T10:01:00Z" }],
      { state: "claimed", claimToken: "t", attempt: 2 },
    ],
    [
      [{ state: "succeeded", claim_token: null, attempt: 1, lease_until: null }],
      { state: "succeeded" },
    ],
    [[{ state: "failed", claim_token: null, attempt: 1, lease_until: null }], { state: "failed" }],
    [
      [{ state: "running", claim_token: null, attempt: 1, lease_until: "2026-10-15T10:01:00Z" }],
      { state: "running", leaseUntil: new Date("2026-10-15T10:01:00Z") },
    ],
  ])("maps begin_job_execution %j", async (data, expected) => {
    const { client } = fakeClient({ begin_job_execution: ok(data) });
    expect(await createSupabaseJobStore(client).begin("sample-ping", "k", 60)).toEqual(expected);
  });

  it.each([
    [[]],
    [[{ state: "claimed", claim_token: null, attempt: 1, lease_until: null }]],
    [[{ state: "odd" }]],
  ])("refuses an unexpected begin result %j", async (data) => {
    const { client } = fakeClient({ begin_job_execution: ok(data) });
    await expect(createSupabaseJobStore(client).begin("sample-ping", "k", 60)).rejects.toThrow(
      JobStoreError,
    );
  });

  it("omits the error code of a success and sends the code of a failure", async () => {
    const { client, calls } = fakeClient({ finish_job_execution: ok(true) });
    const store = createSupabaseJobStore(client);
    await store.finish("sample-ping", "k", "t", "succeeded", null);
    await store.finish("sample-ping", "k", "t", "failed_retryable", "busy");
    expect(calls.map((call) => call.args)).toEqual([
      {
        p_job_name: "sample-ping",
        p_idempotency_key: "k",
        p_claim_token: "t",
        p_outcome: "succeeded",
      },
      {
        p_job_name: "sample-ping",
        p_idempotency_key: "k",
        p_claim_token: "t",
        p_outcome: "failed_retryable",
        p_error_code: "busy",
      },
    ]);
  });

  it("throws a JobStoreError with the code only", async () => {
    const { client } = fakeClient({
      claim_job_outbox: {
        data: null,
        error: { code: "42501", message: "permission denied for alice@example.com" },
      },
    });
    const failure = createSupabaseJobStore(client).claim(1, 60);
    await expect(failure).rejects.toMatchObject({ name: "JobStoreError", code: "42501" });
    await expect(failure).rejects.not.toThrow(/alice/);
  });

  it("refuses an unexpected fail result", async () => {
    const { client } = fakeClient({ fail_job_outbox: ok("weird") });
    await expect(createSupabaseJobStore(client).fail("r", "x", true)).rejects.toThrow(
      JobStoreError,
    );
  });
});
