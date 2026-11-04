// S30c: races the habit-to-goal links must decide in the database. Two habits linked to one goal get
// progress at the same moment (both reach the goal exactly once); two people add to the same linked
// habit at once; a habit entry races the confirmation of a new link (the link is either created with
// every entry from its start, or refused as stale, never created with a stale amount); and a habit
// entry races the goal being unarchived (the goal ends up counting it whichever runs first).
//
// Like the other concurrency tests this needs overlapping psql sessions, so the data is committed.
// It uses the seeded users and removes what it created afterwards; the database is a disposable
// local test database (architecture.md §25).
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const user = (name: string) => `(select id from auth.users where email = '${name}@madeora.test')`;
const HOME = "6d3a9e4c-5f7b-4a8c-9dae-2f3a4b5c6d01";
const RUN = "6d3a9e4c-5f7b-4a8c-9dae-2f3a4b5c6d02";
const WALK = "6d3a9e4c-5f7b-4a8c-9dae-2f3a4b5c6d03";
const GOAL = "6d3a9e4c-5f7b-4a8c-9dae-2f3a4b5c6d04";
const OTHER = "6d3a9e4c-5f7b-4a8c-9dae-2f3a4b5c6d05";
const LINK_RUN = "6d3a9e4c-5f7b-4a8c-9dae-2f3a4b5c6d06";
const LINK_WALK = "6d3a9e4c-5f7b-4a8c-9dae-2f3a4b5c6d07";
const LINK_NEW = "6d3a9e4c-5f7b-4a8c-9dae-2f3a4b5c6d08";

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

/** Adds progress to a habit today and holds the transaction open a moment. */
const add = (habit: string, quantity: number) =>
  `select public.add_habit_contribution(gen_random_uuid(), '${habit}', ${String(quantity)}) ->> 'outcome';
select pg_sleep(0.3);`;

/** A km habit of the Home that started ten days ago. */
function habit(id: string, name: string) {
  return `insert into private.habits (id, owner_home_id, name, week_start, created_by)
  values ('${id}', '${HOME}', '${name}', 'monday', ${user("alice")});
insert into private.habit_periods (habit_id, starts_on) values ('${id}', current_date - 10);
insert into private.habit_schedules (habit_id, effective_on, kind) values ('${id}', current_date - 10, 'daily');
insert into private.habit_tracking (habit_id, effective_on, mode, target, unit, unit_kind)
  values ('${id}', current_date - 10, 'numeric', 5, 'km', 'preset');`;
}

/** A 100 km goal of the Home. */
function goal(id: string, title: string) {
  return `insert into private.goals (id, owner_home_id, kind, title, target, unit, unit_kind, created_by)
  values ('${id}', '${HOME}', 'measurable', '${title}', 100, 'km', 'preset', ${user("alice")});`;
}

const scalar = async (sql: string): Promise<string | undefined> => (await psql(sql))[0];
const linked = (goalId: string) =>
  scalar(`select private.goal_linked_total(g) from private.goals g where g.id = '${goalId}';`);
/** Everything a habit has recorded (all of it counts: the links start ten days ago). */
const recorded = (habitId: string) =>
  scalar(`select coalesce(sum(quantity), 0)::numeric(16, 3) from private.habit_contributions
  where habit_id = '${habitId}' and status = 'active';`);

async function cleanUp(): Promise<void> {
  // Habits, goals, links and the linked ledger go with the Home (on delete cascade).
  await psql(`delete from public.homes where id = '${HOME}';`);
}

beforeAll(async () => {
  await cleanUp();
  await psql(`begin;
insert into public.homes (id, name, timezone, created_by, creation_request_id)
  values ('${HOME}', 'Loophuis', 'Europe/Brussels', ${user("alice")}, gen_random_uuid());
insert into public.home_memberships (home_id, user_id, role) values
  ('${HOME}', ${user("alice")}, 'owner'), ('${HOME}', ${user("bob")}, 'member');
${habit(RUN, "Lopen")}
${habit(WALK, "Wandelen")}
${goal(GOAL, "Honderd")}
${goal(OTHER, "Ander")}
insert into private.goal_habit_links (id, habit_id, goal_id, starts_on, created_by) values
  ('${LINK_RUN}', '${RUN}', '${GOAL}', current_date - 10, ${user("alice")}),
  ('${LINK_WALK}', '${WALK}', '${GOAL}', current_date - 10, ${user("alice")});
commit;`);
});
afterAll(cleanUp);

describe("simultaneous habit progress", () => {
  it("counts two linked habits' progress into one goal exactly", async () => {
    const results = await Promise.all([as("alice", add(RUN, 2.5)), as("bob", add(WALK, 1.25))]);
    expect(results.map(([outcome]) => outcome)).toEqual(["added", "added"]);
    expect(await linked(GOAL)).toBe("3.750");
  });

  it("counts two people's progress on one linked habit exactly", async () => {
    const results = await Promise.all([as("alice", add(RUN, 0.5)), as("bob", add(RUN, 0.75))]);
    expect(results.map(([outcome]) => outcome)).toEqual(["added", "added"]);
    expect(await linked(GOAL)).toBe("5.000");
  });
});

describe("habit progress racing goal changes", () => {
  it("never creates a link with a stale amount when progress races its confirmation", async () => {
    const [preview] = await as(
      "alice",
      `select (x ->> 'revision') || ':' || (x -> 'impact' ->> 'amountAfter')
       from (select public.create_goal_link('${LINK_NEW}', '${RUN}', '${OTHER}', null, 'beginning', null, true) as x) y;`,
    );
    const [revision, amount] = (preview ?? "").split(":");
    const results = await Promise.all([
      as(
        "alice",
        `select public.create_goal_link('${LINK_NEW}', '${RUN}', '${OTHER}', null, 'beginning', null, false,
          ${revision ?? "0"}, ${amount ?? "0"}) ->> 'outcome';
select pg_sleep(0.3);`,
      ),
      as("bob", add(RUN, 1)),
    ]);
    expect(results[1][0]).toBe("added");
    expect(["created", "stale"]).toContain(results[0][0]);
    if (results[0][0] === "created") {
      expect(await linked(OTHER)).toBe(await recorded(RUN));
    } else {
      expect(Number(await linked(OTHER))).toBe(0);
    }
  });

  it("counts progress made while the goal is unarchived, whichever runs first", async () => {
    await psql(`update private.goals set archived_at = now(), archived_by = ${user("alice")}
      where id = '${GOAL}';`);
    const [revision] = await psql(`select revision from private.goals where id = '${GOAL}';`);
    const results = await Promise.all([
      as(
        "alice",
        `select outcome from public.archive_goal('${GOAL}', ${revision ?? "0"}, false);
select pg_sleep(0.3);`,
      ),
      as("bob", add(WALK, 2)),
    ]);
    expect(results.map(([outcome]) => outcome)).toEqual(["saved", "added"]);
    const [run, walk] = await Promise.all([recorded(RUN), recorded(WALK)]);
    expect(Number(await linked(GOAL))).toBe(Number(run) + Number(walk));
  });
});
