// S19c: two uploads opened at the same moment for a task with one place left cannot both take it,
// and two removals of the same attachment record one trash entry. The intent locks the task row
// before it counts, so the second waits and then sees the first one's upload in progress; a removal
// locks the task and then the attachment, so the second finds it already removed.
//
// Like storage-concurrency.test.ts this needs overlapping psql sessions, so the data is committed.
// It uses the seeded user Carol's Personal space and deletes everything afterwards; the database is a
// disposable local test database (architecture.md §25).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const carol = "(select id from auth.users where email = 'carol@madeora.test')";
const listId = randomUUID();
const taskId = randomUUID();

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

let claims = "";
const asCarol = (sql: string) => `begin;
set local role authenticated;
select set_config('request.jwt.claims', '${claims}', true);
${sql}
commit;`;

// Ready files attached to the task, as setup (the owner, outside the API).
function attachedFiles(count: number): string {
  return `do $$
declare
  v_pool uuid := (private.lock_storage_pool(${carol}, null)).id;
  v_file uuid;
begin
  for i in 1..${String(count)} loop
    insert into private.stored_files (pool_id, purpose, created_by, request_id, upload_key, object_key,
      declared_type, declared_size, content_type, size_bytes, sha256, status, expires_at, finalized_at)
    values (v_pool, 'task_attachment', ${carol}, gen_random_uuid(), private.new_object_key('u'),
      private.new_object_key('u'), 'application/pdf', 10, 'application/pdf', 10, repeat('c', 64),
      'ready', now() + interval '15 minutes', now())
    returning id into v_file;
    insert into private.task_attachments (task_id, file_id, display_name, added_by)
      values ('${taskId}', v_file, 'Setup.pdf', ${carol});
  end loop;
end
$$;`;
}

async function cleanUp(): Promise<void> {
  // Deleting the task releases its files, which queues their objects for deletion: remember the
  // keys first so those queued deletions and jobs are removed too.
  await psql(`create temporary table carol_keys as
      select f.object_key from private.stored_files f
        join private.storage_pools p on p.id = f.pool_id where p.owner_user_id = ${carol};
    delete from private.job_outbox o
      where o.payload ->> 'entryId' in (select e.id::text from private.trash_entries e
        where e.owner_user_id = ${carol} and e.item_type = 'task_attachment');
    delete from private.trash_entries where owner_user_id = ${carol} and item_type = 'task_attachment';
    delete from private.tasks where id = '${taskId}';
    delete from private.task_lists where id = '${listId}';
    delete from private.job_outbox o
      where o.payload ->> 'fileId' in (select f.id::text from private.stored_files f
        join private.storage_pools p on p.id = f.pool_id where p.owner_user_id = ${carol});
    delete from private.storage_pools where owner_user_id = ${carol};
    delete from private.job_outbox where job_name = 'storage-object-delete'
      and payload ->> 'deletionId' in (select d.id::text from private.storage_object_deletions d
        where (d.reason = 'owner_deleted' and d.done_at is null)
          or d.object_key in (select object_key from carol_keys));
    delete from private.storage_object_deletions d
      where (d.reason = 'owner_deleted' and d.done_at is null)
        or d.object_key in (select object_key from carol_keys);`);
}

beforeAll(async () => {
  await cleanUp();
  const [value] = await psql(
    `select json_build_object('sub', ${carol}, 'role', 'authenticated')::text;`,
  );
  claims = value ?? "";
  await psql(
    asCarol(`select public.create_task_list('${listId}', 'Race');
select public.create_task('${taskId}', '${listId}', 'Race task');`),
  );
});

afterAll(cleanUp);

describe("simultaneous attachment uploads", () => {
  it("lets only one of two uploads take a task's last place", async () => {
    await psql(attachedFiles(9));
    const results = await Promise.all(
      [0, 1].map(() =>
        psql(
          asCarol(`select outcome from public.create_task_attachment_intent('${taskId}',
  'application/pdf', 100, 'Race.pdf', gen_random_uuid());
select pg_sleep(0.3);`),
        ),
      ),
    );
    const outcomes = results.map(([, outcome]) => outcome).sort();
    expect(outcomes).toEqual(["limit_reached", "ok"]);
  });
});

describe("simultaneous removals", () => {
  it("removes an attachment once when two people remove it at the same moment", async () => {
    const [attachmentId] = await psql(
      `select id from private.task_attachments where task_id = '${taskId}' order by id limit 1;`,
    );
    expect(attachmentId).toMatch(/^[0-9a-f-]{36}$/);
    const results = await Promise.all(
      [0, 1].map(() =>
        psql(
          asCarol(`select outcome from public.remove_task_attachment('${attachmentId ?? ""}');
select pg_sleep(0.3);`),
        ),
      ),
    );
    const outcomes = results.map(([, outcome]) => outcome).sort();
    expect(outcomes).toEqual(["not_found", "removed"]);
    const [entries] = await psql(
      `select count(*) from private.trash_entries where subject_id = '${attachmentId ?? ""}';`,
    );
    expect(entries).toBe("1");
  });
});
