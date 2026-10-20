// S19: recurring tasks under simultaneous requests. Two page loads advancing the same series at once
// create each occurrence once; a change to the entire series racing an edit of one of its
// occurrences never loses either (the occurrence either keeps its own change, marked as changed on
// its own, or the stale edit answers conflict); and removing following occurrences racing the
// completion of one of them never trashes a completed occurrence.
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
const homeName = "Series Race Home";
const home = `(select id from public.homes where name = '${homeName}')`;
const today = "(now() at time zone 'Europe/Brussels')::date";

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

/** A new daily series by Alice in a new list, starting today; returns the series id. */
async function newSeries(title: string): Promise<string> {
  const [list = ""] = await as(
    alice,
    `select l from gen_random_uuid() l, public.create_task_list(l, '${title} list', ${home}) r;`,
  );
  const [series = ""] = await psql(`select gen_random_uuid();`);
  const [outcome] = await as(
    alice,
    `select outcome from public.create_task_series('${series}', '${list}', '${title}', 'daily', 1,
      ${today}, p_home_id => ${home});`,
  );
  expect(outcome).toBe("created");
  return series;
}

/** Moves a chain `days` into the past, as if that many days had passed. */
async function shiftBack(series: string, count: number): Promise<void> {
  const days = String(count);
  await psql(`begin;
    update private.task_series set starts_on = starts_on - ${days}, next_date = next_date - ${days},
      last_date = last_date - ${days} where root_id = '${series}';
    update private.tasks set occurrence_date = occurrence_date - ${days} - 100000,
      due_date = due_date - ${days} where series_root_id = '${series}';
    update private.tasks set occurrence_date = occurrence_date + 100000 where series_root_id = '${series}';
    commit;`);
}

async function occurrence(series: string, days: number): Promise<string> {
  const offset = String(days);
  const [id = ""] = await psql(`select id from private.tasks
    where series_root_id = '${series}' and occurrence_date = ${today} + ${offset};`);
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

describe("advancing", () => {
  it("creates each occurrence once when two page loads advance at the same time", async () => {
    const series = await newSeries("Water plants");
    await shiftBack(series, 5);
    const results = await Promise.all(
      [alice, carol].map((user) =>
        as(
          user,
          `select public.advance_task_series(${home});
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([created]) => Number(created)).sort()).toEqual([0, 5]);
    const [total, dates] =
      await psql(`select count(*) from private.tasks where series_root_id = '${series}';
      select count(distinct occurrence_date) from private.tasks where series_root_id = '${series}';`);
    expect(total).toBe("7");
    expect(dates).toBe("7");
  });
});

describe("a series change racing an occurrence edit", () => {
  it("never loses either change", async () => {
    const series = await newSeries("Feed the cat");
    const today0 = await occurrence(series, 0);
    const tomorrow = await occurrence(series, 1);
    const [seriesEdit, occurrenceEdit] = await Promise.all([
      as(
        alice,
        `select outcome from public.update_task_series('${today0}', 'series', 1, 1, false,
          p_set_content => true, p_title => 'Feed the cats', p_label_ids => '{}');
select pg_sleep(0.3);`,
      ),
      as(
        alice,
        `select outcome from public.update_task('${tomorrow}', 1, 'Feed the cat (wet food)', '{}');
select pg_sleep(0.3);`,
      ),
    ]);
    const [state = ""] = await psql(`select title || '|' || detached::text from private.tasks
      where id = '${tomorrow}';`);
    expect(seriesEdit[0]).toBe("saved");
    if (occurrenceEdit[0] === "saved") {
      // The occurrence edit went first: the series change kept it.
      expect(state).toBe("Feed the cat (wet food)|true");
    } else {
      // The series change went first: the stale edit changed nothing.
      expect(occurrenceEdit[0]).toBe("conflict");
      expect(state).toBe("Feed the cats|false");
    }
  });
});

describe("two series-wide changes from different occurrences", () => {
  it("queue instead of deadlocking: one saves, the other answers conflict", async () => {
    const series = await newSeries("Air the rooms");
    const today0 = await occurrence(series, 0);
    const tomorrow = await occurrence(series, 1);
    const results = await Promise.all(
      [
        [today0, "Air the bedroom"],
        [tomorrow, "Air the kitchen"],
      ].map(([task, title]) =>
        as(
          alice,
          `select outcome from public.update_task_series('${task ?? ""}', 'series', 1, 1, false,
            p_set_content => true, p_title => '${title ?? ""}', p_label_ids => '{}');
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["conflict", "saved"]);
  });
});

describe("removing following occurrences racing a completion", () => {
  it("never trashes a completed occurrence", async () => {
    const series = await newSeries("Sweep the porch");
    await shiftBack(series, 1);
    await as(alice, `select public.advance_task_series(${home});`);
    const today0 = await occurrence(series, 0);
    const tomorrow = await occurrence(series, 1);
    const [revision = ""] = await psql(
      `select revision from private.task_series where root_id = '${series}';`,
    );
    const [removal, completion] = await Promise.all([
      as(
        alice,
        `select outcome from public.delete_task_series('${today0}', 'following', ${revision}, false);
select pg_sleep(0.3);`,
      ),
      as(
        alice,
        `select outcome from public.set_task_completion('${tomorrow}', true);
select pg_sleep(0.3);`,
      ),
    ]);
    expect(removal[0]).toBe("deleted");
    expect(["completed", "not_found"]).toContain(completion[0]);
    const [trashedCompleted] = await psql(`select count(*) from private.tasks
      where series_root_id = '${series}' and deleted_at is not null and completed_at is not null;`);
    expect(trashedCompleted).toBe("0");
  });
});
