// S15: two uploads opened at the same moment cannot both take the last free space of a pool, and two
// finalize requests for one upload cannot both process it (review H1). The pool row is locked by
// every function that adds bytes, so the second intent waits for the first and then sees its
// reservation; the claim locks the file row, so the second claim sees the first one's lease.
//
// Like notifications-concurrency.test.ts this needs overlapping psql sessions, so the data is
// committed. It uses the seeded user Carol with a small allowance and deletes everything afterwards;
// the database is a disposable local test database (architecture.md §25).
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const carol = "(select id from auth.users where email = 'carol@madeora.test')";

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

async function cleanUp(): Promise<void> {
  await psql(`delete from private.job_outbox o
    where o.payload ->> 'fileId' in (select f.id::text from private.stored_files f
      join private.storage_pools p on p.id = f.pool_id where p.owner_user_id = ${carol});
    delete from private.storage_pools where owner_user_id = ${carol};
    delete from private.job_outbox where job_name = 'storage-object-delete'
      and payload ->> 'deletionId' in (select id::text from private.storage_object_deletions
        where reason = 'owner_deleted' and done_at is null);
    delete from private.storage_object_deletions where reason = 'owner_deleted' and done_at is null;`);
}

beforeAll(async () => {
  await cleanUp();
  await psql(`select public.set_storage_allowance(${carol}, null, 1000);`);
});

afterAll(cleanUp);

describe("simultaneous upload intents", () => {
  it("lets only one of two uploads into the last free space", async () => {
    const results = await Promise.all(
      [0, 1].map(async () => {
        const [claims] = await psql(
          `select json_build_object('sub', ${carol}, 'role', 'authenticated')::text;`,
        );
        return psql(`begin;
set local role authenticated;
select set_config('request.jwt.claims', '${claims ?? ""}', true);
select outcome from public.create_upload_intent('avatar', 'image/png', 600, gen_random_uuid());
select pg_sleep(0.3);
commit;`);
      }),
    );
    const outcomes = results.map(([, outcome]) => outcome).sort();
    expect(outcomes).toEqual(["ok", "storage_full"]);
  });
});

describe("simultaneous finalize claims", () => {
  it("lets only one of two finalize requests process the same upload", async () => {
    const [claims] = await psql(
      `select json_build_object('sub', ${carol}, 'role', 'authenticated')::text;`,
    );
    const asCarol = (sql: string) => `begin;
set local role authenticated;
select set_config('request.jwt.claims', '${claims ?? ""}', true);
${sql}
commit;`;
    const [, fileId] = await psql(
      asCarol(
        "select file_id from public.create_upload_intent('avatar', 'image/png', 300, gen_random_uuid());",
      ),
    );
    expect(fileId).toMatch(/^[0-9a-f-]{36}$/);
    const results = await Promise.all(
      [0, 1].map(() =>
        psql(asCarol(`select public.claim_my_upload('${fileId ?? ""}');\nselect pg_sleep(0.3);`)),
      ),
    );
    const outcomes = results.map(([, outcome]) => outcome).sort();
    expect(outcomes).toEqual(["busy", "claimed"]);
  });
});
