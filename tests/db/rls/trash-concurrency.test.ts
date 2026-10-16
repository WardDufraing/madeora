// S16: two requests that restore or delete the same trash entry at the same moment. Every restore
// and purge locks the entry row first, so the second request waits for the first and then sees its
// result: one restore wins and the other finds nothing to restore; a restore racing an early
// permanent delete ends in exactly one of the two states, never a half-restored item.
//
// Like storage-concurrency.test.ts this needs overlapping psql sessions, so the data is committed.
// It uses the seeded user Carol and deletes everything afterwards; the database is a disposable local
// test database (architecture.md §25).
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
    where o.payload ->> 'entryId' in (select t.id::text from private.trash_entries t
      where t.owner_user_id = ${carol});
    delete from private.job_outbox o
    where o.payload ->> 'fileId' in (select f.id::text from private.stored_files f
      join private.storage_pools p on p.id = f.pool_id where p.owner_user_id = ${carol});
    delete from private.trash_entries where owner_user_id = ${carol};
    delete from private.trash_samples where owner_user_id = ${carol};
    delete from private.storage_pools where owner_user_id = ${carol};
    delete from private.job_outbox where job_name = 'storage-object-delete'
      and payload ->> 'deletionId' in (select id::text from private.storage_object_deletions
        where reason in ('owner_deleted', 'purged') and done_at is null);
    delete from private.storage_object_deletions
      where reason in ('owner_deleted', 'purged') and done_at is null;
    delete from private.audit_events where subject_type = 'trash_entry' and actor_user_id = ${carol};`);
}

/** Carol's sample with a 100-byte file, already in the trash. Returns the entry id. */
async function trashedSample(name: string): Promise<string> {
  const [entry] = await psql(`do $$
declare
  v_pool private.storage_pools;
  v_file uuid;
  v_sample uuid;
begin
  v_pool := private.lock_storage_pool(${carol}, null);
  insert into private.stored_files (
    pool_id, purpose, created_by, request_id, upload_key, object_key, declared_type, declared_size,
    content_type, size_bytes, sha256, status, expires_at, finalized_at
  ) values (
    v_pool.id, 'avatar', ${carol}, gen_random_uuid(), private.new_object_key('u'),
    private.new_object_key('u'), 'image/png', 100, 'image/webp', 100, repeat('d', 64), 'ready',
    now(), now()
  ) returning id into v_file;
  insert into private.trash_samples (owner_user_id, name, file_id, created_by)
    values (${carol}, '${name}', v_file, ${carol}) returning id into v_sample;
  perform private.trash_sample_delete(${carol}, v_sample);
end $$;
select id from private.trash_entries where label = '${name}';`);
  expect(entry).toMatch(/^[0-9a-f-]{36}$/);
  return entry ?? "";
}

async function asCarol(sql: string): Promise<string[]> {
  const [claims] = await psql(
    `select json_build_object('sub', ${carol}, 'role', 'authenticated')::text;`,
  );
  return psql(`begin;
set local role authenticated;
select set_config('request.jwt.claims', '${claims ?? ""}', true);
${sql}
commit;`);
}

beforeAll(cleanUp);
afterAll(cleanUp);

describe("simultaneous restores", () => {
  it("restores an entry once; the second request finds nothing to restore", async () => {
    const entry = await trashedSample("conc-double");
    const results = await Promise.all(
      [0, 1].map(() =>
        asCarol(`select outcome from public.restore_trash_entries(array['${entry}'::uuid]);
select pg_sleep(0.3);`),
      ),
    );
    expect(results.map(([, outcome]) => outcome).sort()).toEqual(["not_found", "restored"]);
    const [state] = await psql(`select count(*) from private.trash_samples
      where name = 'conc-double' and deleted_at is null;`);
    expect(state).toBe("1");
  });
});

describe("a restore racing a permanent delete", () => {
  it("ends with the item restored or removed, never both or half", async () => {
    const entry = await trashedSample("conc-race");
    const [restore, purge] = await Promise.all([
      asCarol(`select outcome from public.restore_trash_entries(array['${entry}'::uuid]);
select pg_sleep(0.3);`),
      asCarol(`select outcome from public.purge_trash_entries(array['${entry}'::uuid]);
select pg_sleep(0.3);`),
    ]);
    const outcomes = [restore[1], purge[1]];
    expect(outcomes.filter((outcome) => outcome === "not_found")).toHaveLength(1);
    const [active] = await psql(
      `select count(*) from private.trash_samples where name = 'conc-race' and deleted_at is null;`,
    );
    const [fileStatus] = await psql(`select f.status from private.trash_entry_files ef
      join private.stored_files f on f.id = ef.file_id where ef.entry_id = '${entry}';`);
    // Restored: the item is active and its file is ready. Deleted: no item and a purged file.
    expect(active === "1" ? fileStatus : `${fileStatus ?? ""}:${active ?? ""}`).toBe(
      active === "1" ? "ready" : "purged:0",
    );
  });
});
