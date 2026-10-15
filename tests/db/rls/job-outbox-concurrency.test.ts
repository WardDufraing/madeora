// S13: simultaneous dispatchers never claim the same outbox row, simultaneous enqueues of one key
// make one row, and simultaneous runs of one job key never both execute (architecture.md §11:
// "each task must be idempotent or have a deduplication key").
//
// Like invitations-concurrency.test.ts, this needs two psql sessions whose transactions overlap, so
// the setup is committed. Every row uses a fresh random key prefix and is deleted afterwards; the
// database is a disposable local test database (architecture.md §25).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const prefix = `concurrency-${randomUUID()}`;

function psql(script: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "psql",
      ["--no-psqlrc", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "--dbname", databaseUrl],
      { env: isolatedEnv() },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.split("\n").filter((line) => line !== ""));
      else reject(new Error(`psql failed: ${stderr}`));
    });
    child.stdin.end(script);
  });
}

/** Runs `sql` as the service role in one transaction. */
function asServiceRole(sql: string): Promise<string[]> {
  return psql(`begin;
set local role service_role;
${sql}
commit;`);
}

afterAll(async () => {
  await psql(`delete from private.job_outbox where idempotency_key like '${prefix}%';
    delete from private.job_executions where idempotency_key like '${prefix}%';`);
});

describe("simultaneous background job work", () => {
  it("never gives one outbox row to two dispatchers", async () => {
    // The claim takes any due row; this test needs a database with none of its own.
    const [due] = await psql(
      `select count(*) from private.job_outbox where status in ('pending', 'dispatching');`,
    );
    expect(due, "the test database must have no due outbox rows").toBe("0");
    await psql(
      `select private.enqueue_job('sample-ping', 1, '${prefix}-row-' || i, '{}')
       from generate_series(1, 10) i;`,
    );

    // Each dispatcher claims at most 6 and keeps its transaction open, so the second one runs
    // while the first one's rows are locked.
    const claims = await Promise.all(
      [0, 1].map(() =>
        asServiceRole(`select c.idempotency_key from public.claim_job_outbox(6, 60) c
  where c.idempotency_key like '${prefix}-row-%';
select pg_sleep(0.5);`),
      ),
    );
    const [first, second] = claims as [string[], string[]];
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(new Set([...first, ...second]).size).toBe(first.length + second.length);
    expect(first.length + second.length).toBe(10);
  });

  it("makes one row when the same job is enqueued twice at once", async () => {
    const results = await Promise.all(
      [0, 1].map(() =>
        psql(`begin;
select private.enqueue_job('sample-ping', 1, '${prefix}-same', '{}');
select pg_sleep(0.3);
commit;`),
      ),
    );
    const ids = results.map(([id]) => id);
    expect(ids[0]).toBeDefined();
    expect(ids[0]).toBe(ids[1]);
    const [count] = await psql(
      `select count(*) from private.job_outbox where idempotency_key = '${prefix}-same';`,
    );
    expect(count).toBe("1");
  });

  it("lets only one of two simultaneous runs execute a job key", async () => {
    const states = await Promise.all(
      [0, 1].map(() =>
        asServiceRole(`select state from public.begin_job_execution('sample-ping', '${prefix}-exec', 60);
select pg_sleep(0.5);`),
      ),
    );
    expect(states.map(([state]) => state).sort()).toEqual(["claimed", "running"]);
  });
});
