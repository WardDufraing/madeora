// S29: races the numeric habit functions must decide in the database. Two members add the last
// glasses of a shared habit at once (exactly one completion, nothing lost); the same contribution id
// arrives twice at once (counted once); and a same-day target change races a contribution (the change
// either wins and the contribution lands on the new target, or is told its preview is stale).
//
// Like the other concurrency tests this needs overlapping psql sessions, so the data is committed.
// It uses the seeded users and removes what it created afterwards; the database is a disposable
// local test database (architecture.md §25).
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const user = (name: string) => `(select id from auth.users where email = '${name}@madeora.test')`;
const HOME = "8e3c5fb7-0c6b-4a88-8d6b-5c9d4b3f5801";
const HABIT = "8e3c5fb7-0c6b-4a88-8d6b-5c9d4b3f5802";
const HABIT_TWO = "8e3c5fb7-0c6b-4a88-8d6b-5c9d4b3f5803";
const ids = Array.from(
  { length: 12 },
  (_, index) => `8e3c5fb7-0c6b-4a88-8d6b-5c9d4b3f59${String(index).padStart(2, "0")}`,
);
const id = (index: number): string => ids[index] ?? "";

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
  // Habits, tracking, contributions and check-ins go with the Home (on delete cascade).
  await psql(`delete from public.homes where id = '${HOME}';`);
}

beforeAll(async () => {
  await cleanUp();
  await psql(`begin;
insert into public.homes (id, name, timezone, created_by, creation_request_id)
  values ('${HOME}', 'Waterhuis', 'Europe/Brussels', ${user("alice")}, gen_random_uuid());
insert into public.home_memberships (home_id, user_id, role) values
  ('${HOME}', ${user("alice")}, 'owner'), ('${HOME}', ${user("bob")}, 'member');
insert into private.habits (id, owner_home_id, name, week_start, created_by) values
  ('${HABIT}', '${HOME}', 'Water', 'monday', ${user("alice")}),
  ('${HABIT_TWO}', '${HOME}', 'Lezen', 'monday', ${user("alice")});
insert into private.habit_periods (habit_id, starts_on) values
  ('${HABIT}', ${day(-3)}), ('${HABIT_TWO}', ${day(-3)});
insert into private.habit_schedules (habit_id, effective_on, kind) values
  ('${HABIT}', ${day(-3)}, 'daily'), ('${HABIT_TWO}', ${day(-3)}, 'daily');
insert into private.habit_tracking (habit_id, effective_on, mode, target, unit, unit_kind) values
  ('${HABIT}', ${day(-3)}, 'numeric', 3, 'glasses', 'preset'),
  ('${HABIT_TWO}', ${day(-3)}, 'numeric', 10, 'pages', 'preset');
insert into private.habit_contributions (id, habit_id, on_date, quantity, contributed_by, source) values
  ('${id(0)}', '${HABIT}', ${day(0)}, 1, ${user("alice")}, 'app'),
  ('${id(1)}', '${HABIT_TWO}', ${day(0)}, 4, ${user("alice")}, 'app');
commit;`);
});
afterAll(cleanUp);

describe("simultaneous numeric progress", () => {
  it("completes the day exactly once when two members add the last glasses at once", async () => {
    const results = await Promise.all(
      (
        [
          ["alice", id(2)],
          ["bob", id(3)],
        ] as const
      ).map(([name, contribution]) =>
        as(
          name,
          `select r ->> 'outcome', r ->> 'completedNow'
  from public.add_habit_contribution('${contribution}', '${HABIT}', 1) r;
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([row]) => row).sort()).toEqual(["added|false", "added|true"]);
    const [counts] = await psql(
      `select (select count(*) from private.habit_checkins where habit_id = '${HABIT}'
    and on_date = ${day(0)} and status = 'active' and derived),
  (select sum(quantity) from private.habit_contributions where habit_id = '${HABIT}'
    and on_date = ${day(0)} and status = 'active');`,
    );
    expect(counts).toBe("1|3.000");
  });

  it("counts a contribution id that arrives twice at once only once", async () => {
    const results = await Promise.all(
      ["alice", "alice"].map((name) =>
        as(
          name,
          `select public.add_habit_contribution('${id(4)}', '${HABIT_TWO}', 1) ->> 'outcome';
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["added", "exists"]);
    const [total] = await psql(
      `select sum(quantity) from private.habit_contributions where habit_id = '${HABIT_TWO}'
  and on_date = ${day(0)} and status = 'active';`,
    );
    expect(total).toBe("5.000");
  });

  it("never loses progress or double-completes when a same-day target change races a contribution", async () => {
    // Pages: 5 of 10 now. Alice lowers the target to 6 (preview said 5 pages, no flip); Bob adds 1.
    const [revision] = await psql(`select revision from private.habits where id = '${HABIT_TWO}';`);
    const results = await Promise.all([
      as(
        "alice",
        `select outcome from public.change_habit_tracking('${HABIT_TWO}', ${revision ?? "1"}, 'numeric', 6,
  'pages', 'preset', null, 'today', null, 5, true, false, false);
select pg_sleep(0.3);`,
      ),
      as(
        "bob",
        `select public.add_habit_contribution('${id(5)}', '${HABIT_TWO}', 1) ->> 'outcome';
select pg_sleep(0.3);`,
      ),
    ]);
    const [change] = results[0];
    expect(["saved", "stale", "conflict"]).toContain(change);
    expect(results[1][0]).toBe("added");
    const [state] = await psql(
      `select (select sum(quantity) from private.habit_contributions where habit_id = '${HABIT_TWO}'
    and on_date = ${day(0)} and status = 'active'),
  (select count(*) from private.habit_checkins where habit_id = '${HABIT_TWO}'
    and on_date = ${day(0)} and status = 'active'),
  (select (private.habit_tracking_on('${HABIT_TWO}', ${day(0)})).target);`,
    );
    const [total, active, target] = (state ?? "").split("|");
    expect(total).toBe("6.000");
    // The day is complete exactly when its total reaches the target in force, never twice.
    expect(active).toBe(Number(total) >= Number(target) ? "1" : "0");
  });
});
