// S28: races the habit functions must decide in the database. Two members check in the same day of a
// shared habit at once (one check-in, the other told who did it); two members take the last slot of
// a weekly target at once (the target is never exceeded); and the same reactivation is confirmed twice
// at once (exactly one new tracking period).
//
// Like the other concurrency tests this needs overlapping psql sessions, so the data is committed.
// It uses the seeded users and removes what it created afterwards; the database is a disposable
// local test database (architecture.md §25).
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const user = (name: string) => `(select id from auth.users where email = '${name}@madeora.test')`;
const HOME = "8e3c5fb7-0c6b-4a88-8d6b-5c9d4b3f5701";
const DAILY = "8e3c5fb7-0c6b-4a88-8d6b-5c9d4b3f5702";
const WEEKLY = "8e3c5fb7-0c6b-4a88-8d6b-5c9d4b3f5703";
const ENDED = "8e3c5fb7-0c6b-4a88-8d6b-5c9d4b3f5704";
const CHECK_A = "8e3c5fb7-0c6b-4a88-8d6b-5c9d4b3f5705";
const CHECK_B = "8e3c5fb7-0c6b-4a88-8d6b-5c9d4b3f5706";
const CHECK_C = "8e3c5fb7-0c6b-4a88-8d6b-5c9d4b3f5707";
const CHECK_D = "8e3c5fb7-0c6b-4a88-8d6b-5c9d4b3f5708";

const day = (offset: number) =>
  `((now() at time zone 'Europe/Brussels')::date + ${String(offset)})`;

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

async function as(name: string, sql: string): Promise<string[]> {
  const [claims] = await psql(
    `select json_build_object('sub', ${user(name)}, 'role', 'authenticated')::text;`,
  );
  // The first line is set_config's own answer.
  const lines = await psql(`begin;
set local role authenticated;
select set_config('request.jwt.claims', '${claims ?? ""}', true);
${sql}
commit;`);
  return lines.slice(1);
}

async function cleanUp(): Promise<void> {
  // Habits, check-ins and periods go with the Home (on delete cascade).
  await psql(`delete from public.homes where id = '${HOME}';`);
}

beforeAll(async () => {
  await cleanUp();
  // A weekly target of two, one already done this week on another day than today (a Monday-start
  // week: yesterday when today is not Monday, otherwise the week has only today, so the target is 1
  // and the race is for that single slot). The ended habit stopped yesterday.
  await psql(`begin;
insert into public.homes (id, name, timezone, created_by, creation_request_id)
  values ('${HOME}', 'Gewoontehuis', 'Europe/Brussels', ${user("alice")}, gen_random_uuid());
insert into public.home_memberships (home_id, user_id, role) values
  ('${HOME}', ${user("alice")}, 'owner'), ('${HOME}', ${user("bob")}, 'member');
insert into private.habits (id, owner_home_id, name, week_start, created_by) values
  ('${DAILY}', '${HOME}', 'Planten', 'monday', ${user("alice")}),
  ('${WEEKLY}', '${HOME}', 'Sporten', 'monday', ${user("alice")}),
  ('${ENDED}', '${HOME}', 'Lezen', 'monday', ${user("alice")});
insert into private.habit_periods (habit_id, starts_on, ends_on) values
  ('${DAILY}', ${day(-3)}, null), ('${WEEKLY}', ${day(-7)}, null), ('${ENDED}', ${day(-5)}, ${day(-1)});
insert into private.habit_schedules (habit_id, effective_on, kind, weekdays, weekly_target) values
  ('${DAILY}', ${day(-3)}, 'daily', null, null), ('${WEEKLY}', ${day(-7)}, 'weekly', null, 2),
  ('${ENDED}', ${day(-5)}, 'daily', null, null);
insert into private.habit_checkins (id, habit_id, on_date, completed_by, source)
  select gen_random_uuid(), '${WEEKLY}', ${day(-1)}, ${user("alice")}, 'app'
  where extract(isodow from ${day(0)}) <> 1;
commit;`);
});
afterAll(cleanUp);

describe("simultaneous habit check-ins", () => {
  it("records one check-in when two members complete the same day at once", async () => {
    const results = await Promise.all(
      (
        [
          ["alice", CHECK_A],
          ["bob", CHECK_B],
        ] as const
      ).map(([name, id]) =>
        as(
          name,
          `select public.complete_habit('${id}', '${DAILY}', ${day(0)}, null, 'app') ->> 'outcome';
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["already_completed", "completed"]);
    const [count] = await psql(
      `select count(*) from private.habit_checkins
  where habit_id = '${DAILY}' and on_date = ${day(0)} and status = 'active';`,
    );
    expect(count).toBe("1");
  });

  it("never lets two members both take the last slot of a weekly target", async () => {
    // Today and, when there is one, the day before yesterday in the same week: two different days,
    // one slot left.
    const results = await Promise.all(
      (
        [
          ["alice", CHECK_C, day(0)],
          [
            "bob",
            CHECK_D,
            `(case when extract(isodow from ${day(0)}) >= 3 then ${day(-2)} else ${day(0)} end)`,
          ],
        ] as const
      ).map(([name, id, on]) =>
        as(
          name,
          `select public.complete_habit('${id}', '${WEEKLY}', ${on}, null, 'app') ->> 'outcome';
select pg_sleep(0.3);`,
        ),
      ),
    );
    const outcomes = results.map(([outcome]) => outcome);
    expect(outcomes.filter((outcome) => outcome === "completed")).toHaveLength(1);
    expect(
      outcomes.every((outcome) =>
        ["completed", "target_reached", "already_completed"].includes(outcome ?? ""),
      ),
    ).toBe(true);
    const [over] = await psql(
      `select count(*) from private.habit_weeks(
  (select h from private.habits h where h.id = '${WEEKLY}'), ${day(0)}, ${day(0)}, ${day(0)}) w
  where w.completions > w.adjusted;`,
    );
    expect(over).toBe("0");
  });

  it("creates exactly one new tracking period when a reactivation is confirmed twice at once", async () => {
    const [revision] = await psql(`select revision from private.habits where id = '${ENDED}';`);
    const results = await Promise.all(
      ["alice", "alice"].map((name) =>
        as(
          name,
          `select outcome from public.reactivate_habit('${ENDED}', ${revision ?? "1"}, ${day(0)}, null,
  'daily', null, null, 'off', null, null, false);
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["conflict", "reactivated"]);
    const [periods] = await psql(
      `select count(*) from private.habit_periods where habit_id = '${ENDED}';`,
    );
    expect(periods).toBe("2");
  });
});
