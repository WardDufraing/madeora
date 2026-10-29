// S30b: races the recurring-goal rollover must decide in the database. The background run and a
// person's read roll the same series at once (one new period, one finalization); and a goal
// manager's correction of an ended period races its finalization (whichever runs first, the period
// ends with the corrected total and outcome, never the stale one).
//
// Like the other concurrency tests this needs overlapping psql sessions, so the data is committed.
// It uses the seeded users and removes what it created afterwards; the database is a disposable
// local test database (architecture.md §25).
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const user = (name: string) => `(select id from auth.users where email = '${name}@madeora.test')`;
const HOME = "5c2f8d3b-4e6a-4f7b-8c9d-1e2f3a4b5c01";
const SERIES = "5c2f8d3b-4e6a-4f7b-8c9d-1e2f3a4b5c02";
const OCTOBER = "5c2f8d3b-4e6a-4f7b-8c9d-1e2f3a4b5c03";
const NOVEMBER = "5c2f8d3b-4e6a-4f7b-8c9d-1e2f3a4b5c04";
const ENTRY_OCTOBER = "5c2f8d3b-4e6a-4f7b-8c9d-1e2f3a4b5c05";
const ENTRY_NOVEMBER = "5c2f8d3b-4e6a-4f7b-8c9d-1e2f3a4b5c06";

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

function asServiceRole(sql: string): Promise<string[]> {
  return psql(`begin;
set local role service_role;
${sql}
commit;`);
}

/** An ended period of the series with one contribution by Bob, waiting for its finalization. */
function endedPeriod(goal: string, entry: string, start: string, end: string, quantity: number) {
  return `insert into private.goals (id, owner_home_id, kind, title, target, unit, unit_kind, deadline,
    series_id, period_start, period_end) values
  ('${goal}', '${HOME}', 'measurable', 'Lopen', 100, 'km', 'preset', '${end}', '${SERIES}', '${start}', '${end}');
insert into private.goal_entries (id, goal_id, kind, quantity, unit, unit_kind, contributed_by, source) values
  ('${entry}', '${goal}', 'contribution', ${String(quantity)}, 'km', 'preset', ${user("bob")}, 'app');
update private.goal_series set next_roll_at = now() - interval '1 minute' where id = '${SERIES}';`;
}

const periods = async (): Promise<string | undefined> =>
  (await psql(`select count(*) from private.goals where series_id = '${SERIES}';`))[0];

async function cleanUp(): Promise<void> {
  // Series, periods and entries go with the Home (on delete cascade).
  await psql(`delete from public.homes where id = '${HOME}';`);
}

beforeAll(async () => {
  await cleanUp();
  await psql(`begin;
insert into public.homes (id, name, timezone, created_by, creation_request_id)
  values ('${HOME}', 'Loophuis', 'Europe/Brussels', ${user("alice")}, gen_random_uuid());
insert into public.home_memberships (home_id, user_id, role) values
  ('${HOME}', ${user("alice")}, 'owner'), ('${HOME}', ${user("bob")}, 'member');
insert into private.goal_series (id, owner_home_id, kind, frequency, title, first_period_start, created_by)
  values ('${SERIES}', '${HOME}', 'measurable', 'monthly', 'Lopen', '2020-10-01', ${user("alice")});
insert into private.goal_series_targets (series_id, effective_from, target, unit, unit_kind)
  values ('${SERIES}', '2020-10-01', 100, 'km', 'preset');
${endedPeriod(OCTOBER, ENTRY_OCTOBER, "2020-10-01", "2020-10-31", 75)}
commit;`);
});
afterAll(cleanUp);

describe("simultaneous rollovers", () => {
  it("creates the new period and finalizes the ended one once when two rollovers race", async () => {
    const results = await Promise.all([
      asServiceRole(`select public.roll_goal_periods();
select pg_sleep(0.3);`),
      as(
        "bob",
        `select public.sync_goal_periods('${HOME}');
select pg_sleep(0.3);`,
      ),
    ]);
    const created = results.map(([count]) => Number(count));
    expect(created.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await periods()).toBe("2");
    const [finalized] = await psql(
      `select count(*) from private.goal_events where goal_id = '${OCTOBER}' and kind = 'finalized';`,
    );
    expect(finalized).toBe("1");
    const [october] = await psql(
      `select outcome || ':' || outcome_total from private.goals where id = '${OCTOBER}';`,
    );
    expect(october).toBe("not_reached:75.000");
  });

  it("finalizes an ended period with the corrected total when a correction races the rollover", async () => {
    await psql(`begin;
${endedPeriod(NOVEMBER, ENTRY_NOVEMBER, "2020-11-01", "2020-11-30", 90)}
commit;`);
    const results = await Promise.all([
      as(
        "alice",
        `select public.update_goal_entry('${ENTRY_NOVEMBER}', 'amend', 110) ->> 'outcome';
select pg_sleep(0.3);`,
      ),
      asServiceRole(`select public.roll_goal_periods();
select pg_sleep(0.3);`),
    ]);
    expect(results[0][0]).toBe("corrected");
    expect(results[1][0]).toBe("0");
    const [november] = await psql(
      `select outcome || ':' || outcome_total || ':' || (finalized_at is not null)
       from private.goals where id = '${NOVEMBER}';`,
    );
    expect(november).toBe("reached:110.000:true");
    expect(await periods()).toBe("3");
  });
});
