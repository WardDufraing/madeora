// S19b: reminders and bulk actions under simultaneous requests. Two runs of the same reminder job at
// the same moment (a duplicate dispatch, a retry after a lost answer) notify each recipient once;
// a bulk completion racing a single completion of the same task records one completion and one
// audit event; two bulk priority changes from the same preview let one through per task and answer
// the other with a conflict.
//
// Like tasks-concurrency.test.ts this needs overlapping psql sessions, so the data is committed. It
// creates one Home for the seeded users Alice (Owner) and Carol (Member) and deletes it and
// everything it produced afterwards; the database is a disposable local test database
// (architecture.md §25).
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const alice = "(select id from auth.users where email = 'alice@madeora.test')";
const carol = "(select id from auth.users where email = 'carol@madeora.test')";
const homeName = "Reminder Race Home";
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
    where o.job_name = 'task-reminder' and o.payload ->> 'taskId' in (
      select t.id::text from private.tasks t where t.owner_home_id = ${home});
    delete from private.job_outbox o
    where o.job_name = 'notification-email' and o.payload ->> 'notificationId' in (
      select n.id::text from public.notifications n where n.home_id = ${home});
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

/** Runs `sql` as the service role (the jobs). */
async function asService(sql: string): Promise<string[]> {
  return psql(`begin;
set local role service_role;
${sql}
commit;`);
}

let list = "";

/** A new task by Alice, assigned to Alice and Carol, due in three days; returns its id. */
async function newTask(title: string): Promise<string> {
  const [id = ""] = await psql(`select gen_random_uuid();`);
  const [members] = await psql(
    `select array_agg(m.id)::text from public.home_memberships m where m.home_id = ${home};`,
  );
  const [outcome] = await as(
    alice,
    `select outcome from public.create_task('${id}', '${list}', '${title}', null, null,
      current_date + 3, null, '{}', '${members ?? "{}"}'::uuid[], ${home});`,
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
  const [id = ""] = await as(
    alice,
    `select l from gen_random_uuid() l, public.create_task_list(l, 'Race list', ${home}) r;`,
  );
  list = id;
});
afterAll(cleanUp);

describe("reminder delivery", () => {
  it("notifies each recipient once when the same reminder is delivered twice at once", async () => {
    const task = await newTask("Take out the bins");
    const [saved] = await as(
      alice,
      `select outcome from public.set_task_reminder('${task}', 'this', 'relative', 0,
        p_days_before => 1, p_time => '09:00');`,
    );
    expect(saved).toBe("saved");
    // As if its time had come.
    await psql(`update private.task_reminders set fire_at = now() - interval '1 minute'
      where task_id = '${task}';`);
    const results = await Promise.all(
      [0, 1].map(() =>
        asService(`select public.deliver_task_reminder('${task}', 1);
select pg_sleep(0.3);`),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["notified", "stale"]);
    const [count, people] = await psql(`select count(*) from public.notifications
        where kind = 'task.reminder' and params ->> 'taskId' = '${task}';
      select count(distinct user_id) from public.notifications
        where kind = 'task.reminder' and params ->> 'taskId' = '${task}';`);
    expect(count).toBe("2");
    expect(people).toBe("2");
  });
});

describe("bulk actions", () => {
  it("records one completion when a bulk completion races a single one", async () => {
    const task = await newTask("Water the plants");
    const [bulk, single] = await Promise.all([
      as(
        carol,
        `select outcome from public.bulk_update_tasks(array['${task}'::uuid], 'complete',
          jsonb_build_object('${task}', 1), false, ${home});
select pg_sleep(0.3);`,
      ),
      as(
        alice,
        `select outcome from public.set_task_completion('${task}', true);
select pg_sleep(0.3);`,
      ),
    ]);
    expect([
      ["changed", "already_completed"],
      ["unchanged", "completed"],
    ]).toContainEqual([bulk[0], single[0]]);
    const [events] = await psql(`select count(*) from private.audit_events
      where action = 'task.completed' and subject_id = '${task}';`);
    expect(events).toBe("1");
  });

  it("lets one of two bulk changes from the same preview through", async () => {
    const task = await newTask("Fix the fence");
    const results = await Promise.all(
      ["high", "low"].map((priority) =>
        as(
          carol,
          `select outcome from public.bulk_update_tasks(array['${task}'::uuid], 'priority',
            jsonb_build_object('${task}', 1), false, ${home}, p_priority => '${priority}');
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["changed", "conflict"]);
    const [revision] = await psql(`select revision from private.tasks where id = '${task}';`);
    expect(revision).toBe("2");
  });
});
