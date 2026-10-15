// S14: two transactions delivering the same event at once make one notification and one email job
// (the dedupe key and the outbox key), and one of them is told nothing was delivered.
//
// Like job-outbox-concurrency.test.ts this needs two overlapping psql sessions, so the data is
// committed. It uses a random dedupe key on the seeded user Alice and deletes everything afterwards;
// the database is a disposable local test database (architecture.md §25).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const key = `concurrency-${randomUUID()}`;

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

afterAll(async () => {
  await psql(`delete from private.job_outbox
    where (payload ->> 'notificationId')::uuid in
      (select id from public.notifications where dedupe_key = '${key}');
    delete from public.notifications where dedupe_key = '${key}';`);
});

describe("simultaneous notification delivery", () => {
  it("delivers one event once, with one email job, however many deliver it at once", async () => {
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        psql(`begin;
select coalesce(private.notify_user(
  (select id from auth.users where email = 'alice@madeora.test'), null, 'security',
  'recovery.claimant_paused', '{}', '${key}', true)::text, 'none');
select pg_sleep(0.3);
commit;`),
      ),
    );
    const outcomes = results.map(([outcome]) => outcome);
    expect(outcomes.filter((outcome) => outcome !== "none")).toHaveLength(1);
    const [notifications] = await psql(
      `select count(*) from public.notifications where dedupe_key = '${key}';`,
    );
    expect(notifications).toBe("1");
    const [jobs] = await psql(
      `select count(*) from private.job_outbox o
       where o.job_name = 'notification-email'
         and o.payload ->> 'notificationId' in
           (select id::text from public.notifications where dedupe_key = '${key}');`,
    );
    expect(jobs).toBe("1");
  });
});
