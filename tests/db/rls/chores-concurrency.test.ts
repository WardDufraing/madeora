// S20: chores under simultaneous requests. Two page loads advancing the same chore at once create
// each occurrence once; two people completing the same occurrence at once record one completion and
// one event (the other is told it is already done); a completion racing a skip closes the occurrence
// once; a series change racing a completion never rewrites the completed occurrence.
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
const homeName = "Chore Race Home";
const home = `(select id from public.homes where name = '${homeName}')`;
const today = "(now() at time zone 'Europe/Brussels')::date";

/** The user's membership id in the race Home, read as the database owner. */
async function member(user: string): Promise<string> {
  const [id = ""] = await psql(
    `select id from public.home_memberships where home_id = ${home} and user_id = ${user};`,
  );
  return `'${id}'`;
}

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

/** A new daily chore by Alice for nobody in particular, starting today; returns the chore id. */
async function newChore(title: string): Promise<string> {
  const [chore = ""] = await psql(`select gen_random_uuid();`);
  const [outcome] = await as(
    alice,
    `select outcome from public.create_chore('${chore}', ${home}, '${title}',
      '{"mode": "none", "members": []}', p_frequency => 'daily', p_interval => 1, p_starts_on => ${today});`,
  );
  expect(outcome).toBe("created");
  return chore;
}

/** Moves a chore `days` into the past, as if that many days had passed. */
async function shiftBack(chore: string, count: number): Promise<void> {
  const days = String(count);
  await psql(`begin;
    update private.chore_schedules set starts_on = starts_on - ${days}, next_date = next_date - ${days},
      last_date = last_date - ${days} where chore_id = '${chore}';
    update private.chore_occurrences set scheduled_date = scheduled_date - ${days} - 100000,
      due_date = due_date - ${days} where chore_id = '${chore}';
    update private.chore_occurrences set scheduled_date = scheduled_date + 100000 where chore_id = '${chore}';
    commit;`);
}

async function occurrence(chore: string, days: number): Promise<string> {
  const offset = String(days);
  const [id = ""] = await psql(`select id from private.chore_occurrences
    where chore_id = '${chore}' and scheduled_date = ${today} + ${offset};`);
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
    const chore = await newChore("Water plants");
    await shiftBack(chore, 5);
    const results = await Promise.all(
      [alice, carol].map((user) =>
        as(
          user,
          `select public.advance_chores(${home});
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([created]) => Number(created)).sort()).toEqual([0, 5]);
    const [total, dates] =
      await psql(`select count(*) from private.chore_occurrences where chore_id = '${chore}';
      select count(distinct scheduled_date) from private.chore_occurrences where chore_id = '${chore}';`);
    expect(total).toBe("7");
    expect(dates).toBe("7");
  });
});

describe("two completions at once", () => {
  it("record one completion and one event; the other is told it is done", async () => {
    const chore = await newChore("Dishes");
    const today0 = await occurrence(chore, 0);
    const members = [await member(alice), await member(carol)];
    const results = await Promise.all(
      [alice, carol].map((user, index) =>
        as(
          user,
          `select outcome from public.complete_chore_occurrence('${today0}', ${members[index] ?? ""});
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["already_completed", "completed"]);
    const [events] = await psql(`select count(*) from private.chore_occurrence_events
      where occurrence_id = '${today0}';`);
    expect(events).toBe("1");
  });
});

describe("a completion racing a skip", () => {
  it("closes the occurrence once", async () => {
    const chore = await newChore("Bins");
    const today0 = await occurrence(chore, 0);
    const carolMember = await member(carol);
    const [completion, skip] = await Promise.all([
      as(
        carol,
        `select outcome from public.complete_chore_occurrence('${today0}', ${carolMember});
select pg_sleep(0.3);`,
      ),
      as(
        alice,
        `select outcome from public.skip_chore_occurrence('${today0}', 'Away');
select pg_sleep(0.3);`,
      ),
    ]);
    const [status = ""] = await psql(
      `select status from private.chore_occurrences where id = '${today0}';`,
    );
    if (completion[0] === "completed") {
      expect(skip[0]).toBe("already_completed");
      expect(status).toBe("completed");
    } else {
      expect(completion[0]).toBe("already_skipped");
      expect(skip[0]).toBe("skipped");
      expect(status).toBe("skipped");
    }
  });
});

describe("a series change racing a completion", () => {
  it("never rewrites the completed occurrence", async () => {
    const chore = await newChore("Sweep");
    const today0 = await occurrence(chore, 0);
    const [revision = ""] = await psql(
      `select revision from private.chore_schedules where chore_id = '${chore}' and superseded_at is null;`,
    );
    const carolMember = await member(carol);
    const [change, completion] = await Promise.all([
      as(
        alice,
        `select outcome from public.update_chore_series('${today0}', 'series', 1, ${revision}, false,
          p_set_minutes => true, p_minutes => 30);
select pg_sleep(0.3);`,
      ),
      as(
        carol,
        `select outcome from public.complete_chore_occurrence('${today0}', ${carolMember});
select pg_sleep(0.3);`,
      ),
    ]);
    expect(completion[0]).toBe("completed");
    const [state = ""] = await psql(`select status || '|' || coalesce(estimated_minutes::text, '-')
      from private.chore_occurrences where id = '${today0}';`);
    if (change[0] === "saved") {
      // The change went first: the occurrence took it while open, then was completed.
      expect(state).toBe("completed|30");
    } else {
      // The completion went first: the change is stale (its revision moved) or out of scope.
      expect(["conflict", "scope_unavailable"]).toContain(change[0]);
      expect(state).toBe("completed|-");
    }
  });
});

describe("approval under simultaneous requests", () => {
  it("records one submission and one decision", async () => {
    const [chore = ""] = await psql(`select gen_random_uuid();`);
    const [created] = await as(
      alice,
      `select outcome from public.create_chore('${chore}', ${home}, 'Windows',
        '{"mode": "none", "members": []}', p_due_date => ${today}, p_requires_approval => true);`,
    );
    expect(created).toBe("created");
    const [id = ""] = await psql(
      `select id from private.chore_occurrences where chore_id = '${chore}';`,
    );
    const carolMember = await member(carol);
    const submissions = await Promise.all(
      [carol, carol].map((user) =>
        as(
          user,
          `select outcome from public.complete_chore_occurrence('${id}', ${carolMember});
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(submissions.map(([outcome]) => outcome).sort()).toEqual([
      "already_submitted",
      "submitted",
    ]);
    const [revision = ""] = await psql(
      `select revision from private.chore_occurrences where id = '${id}';`,
    );
    const decisions = await Promise.all([
      as(
        alice,
        `select outcome from public.review_chore_submission('${id}', ${revision}, 'approve');
select pg_sleep(0.3);`,
      ),
      as(
        alice,
        `select outcome from public.review_chore_submission('${id}', ${revision}, 'reject', 'Streaks');
select pg_sleep(0.3);`,
      ),
    ]);
    const outcomes = decisions.map(([outcome]) => outcome);
    expect(outcomes.filter((outcome) => outcome === "not_pending")).toHaveLength(1);
    const [count, decided] = await psql(`select count(*) from private.chore_submissions
      where occurrence_id = '${id}';
      select count(*) from private.chore_submissions where occurrence_id = '${id}' and status <> 'pending';`);
    expect(count).toBe("1");
    expect(decided).toBe("1");
  });
});
