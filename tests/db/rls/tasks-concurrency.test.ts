// S18: tasks under simultaneous requests. Two assignees completing the same shared task at the same
// moment record one completion with one actor and one audit event; two edits from the same revision
// let exactly one through; a retried comment send arriving twice stores one comment; a task restore
// racing the deletion of its list never leaves an active task in a deleted list; and two restore
// batches naming the same entries in opposite orders both finish (no deadlock, each entry restored
// once).
//
// Like trash-concurrency.test.ts this needs overlapping psql sessions, so the data is committed. It
// creates one Home for the seeded users Alice (Owner) and Carol (Member) and deletes it and
// everything it produced afterwards; the database is a disposable local test database
// (architecture.md §25).
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const alice = "(select id from auth.users where email = 'alice@madeora.test')";
const carol = "(select id from auth.users where email = 'carol@madeora.test')";
const homeName = "Race Home";
const home = `(select id from public.homes where name = '${homeName}')`;

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
      where t.owner_home_id = ${home});
    delete from private.audit_events where home_id = ${home};
    delete from public.homes where name = '${homeName}';`);
}

/** Runs `sql` as a signed-in user; the first output line is set_config's, the rest are the script's. */
async function as(user: string, sql: string): Promise<string[]> {
  const [claims] = await psql(
    `select json_build_object('sub', ${user}, 'role', 'authenticated')::text;`,
  );
  const lines = await psql(`begin;
set local role authenticated;
select set_config('request.jwt.claims', '${claims ?? ""}', true);
${sql}
commit;`);
  return lines.slice(1);
}

/** A new list in the race Home; returns its id. */
async function newList(name: string): Promise<string> {
  const [id] = await as(
    alice,
    `select l from gen_random_uuid() l, public.create_task_list(l, '${name}', ${home}) r;`,
  );
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  return id ?? "";
}

/** A new task by Alice in `list`, assigned to Alice and Carol; returns its id. */
async function newTask(list: string, title: string): Promise<string> {
  const [id = ""] = await psql(`select gen_random_uuid();`);
  // Read as the database owner: a member reads only their own membership row.
  const [members] = await psql(
    `select array_agg(m.id)::text from public.home_memberships m where m.home_id = ${home};`,
  );
  const [outcome] = await as(
    alice,
    `select outcome from public.create_task('${id}', '${list}', '${title}', null, null, null, null,
      '{}', '${members ?? "{}"}'::uuid[], ${home});`,
  );
  expect(outcome).toBe("created");
  return id;
}

beforeAll(async () => {
  await cleanUp();
  await psql(`begin;
    insert into public.homes (name, timezone, created_by, creation_request_id)
      values ('${homeName}', 'Europe/Brussels', ${alice}, gen_random_uuid());
    insert into public.home_memberships (home_id, user_id, role) values
      (${home}, ${alice}, 'owner'), (${home}, ${carol}, 'member');
    commit;`);
});
afterAll(cleanUp);

describe("shared completion", () => {
  it("records one completion with one actor when two assignees complete at once", async () => {
    const list = await newList("Race list");
    const task = await newTask(list, "Take out the bins");
    const results = await Promise.all(
      [alice, carol].map((user) =>
        as(
          user,
          `select outcome from public.set_task_completion('${task}', true);
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["already_completed", "completed"]);
    const [events, completer] = await psql(`select count(*) from private.audit_events
        where action = 'task.completed' and subject_id = '${task}';
      select (completed_by in (${alice}, ${carol}))::text from private.tasks where id = '${task}';`);
    expect(events).toBe("1");
    expect(completer).toBe("true");
  });
});

describe("simultaneous edits", () => {
  it("lets one edit from a revision through and answers the other with a conflict", async () => {
    const list = await newList("Edit list");
    const task = await newTask(list, "Water the plants");
    const results = await Promise.all(
      ["Water the ferns", "Water the cactus"].map((title) =>
        as(
          carol,
          `select outcome from public.update_task('${task}', 1, '${title}', '{}');
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["conflict", "saved"]);
    const [revision] = await psql(`select revision from private.tasks where id = '${task}';`);
    expect(revision).toBe("2");
  });

  it("stores one comment when the same send arrives twice", async () => {
    const list = await newList("Comment list");
    const task = await newTask(list, "Plan the party");
    const [comment = ""] = await psql(`select gen_random_uuid();`);
    const results = await Promise.all(
      [0, 1].map(() =>
        as(
          carol,
          `select outcome from public.add_task_comment('${comment}', '${task}', 'Saturday?');
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["created", "exists"]);
  });
});

describe("restore racing a list deletion", () => {
  it("never leaves an active task in a deleted list", async () => {
    const list = await newList("Doomed list");
    const task = await newTask(list, "Fix the fence");
    const [entry = ""] = await as(alice, `select entry_id from public.delete_task('${task}');`);
    const [restore, removal] = await Promise.all([
      as(
        alice,
        `select outcome from public.restore_trash_entries(array['${entry}'::uuid]);
select pg_sleep(0.3);`,
      ),
      as(
        alice,
        `select outcome from public.delete_task_list('${list}', 1);
select pg_sleep(0.3);`,
      ),
    ]);
    // Either the restore went first (and the list, now holding it, is kept) or the deletion did (and
    // the restore asks for another list).
    expect([
      ["restored", "has_tasks"],
      ["needs_resolution", "deleted"],
    ]).toContainEqual([restore[0], removal[0]]);
    const [broken] = await psql(`select count(*) from private.tasks t
      join private.task_lists l on l.id = t.list_id
      where t.id = '${task}' and t.deleted_at is null and l.deleted_at is not null;`);
    expect(broken).toBe("0");
  });
});

describe("overlapping restore batches", () => {
  it("restores each entry once when two batches name them in opposite orders", async () => {
    const list = await newList("Batch list");
    const tasks = await Promise.all(
      ["One", "Two", "Three"].map((title) => newTask(list, `Batch ${title}`)),
    );
    const entries: string[] = [];
    for (const task of tasks) {
      const [entry] = await as(alice, `select entry_id from public.delete_task('${task}');`);
      entries.push(entry ?? "");
    }
    const forward = entries.map((id) => `'${id}'::uuid`).join(", ");
    const backward = [...entries]
      .reverse()
      .map((id) => `'${id}'::uuid`)
      .join(", ");
    const results = await Promise.all(
      [forward, backward].map((ids) =>
        as(
          alice,
          `select outcome from public.restore_trash_entries(array[${ids}]);
select pg_sleep(0.3);`,
        ),
      ),
    );
    const outcomes = results.flat().filter((line) => line !== "");
    expect(outcomes.filter((outcome) => outcome === "restored")).toHaveLength(3);
    expect(outcomes.filter((outcome) => outcome === "not_found")).toHaveLength(3);
    const [active] = await psql(`select count(*) from private.tasks
      where id in (${tasks.map((id) => `'${id}'`).join(", ")}) and deleted_at is null;`);
    expect(active).toBe("3");
  });
});
