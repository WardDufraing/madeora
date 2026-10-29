// S30: races the goal functions must decide in the database. Two members contribute to a shared goal
// at once (both counted, the total exact); the same contribution id arrives twice at once (counted
// once); a manager's "set total" races a member's contribution (the total is either set from what the
// manager saw, with the contribution applied on top, or refused as stale, never overwriting it); and
// two managers mark the goal achieved at once (one achievement).
//
// Like the other concurrency tests this needs overlapping psql sessions, so the data is committed.
// It uses the seeded users and removes what it created afterwards; the database is a disposable
// local test database (architecture.md §25).
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const user = (name: string) => `(select id from auth.users where email = '${name}@madeora.test')`;
const HOME = "4b1e7c2a-3d5f-4e6a-9b8c-0d1e2f3a4b01";
const GOAL = "4b1e7c2a-3d5f-4e6a-9b8c-0d1e2f3a4b02";
const ids = Array.from(
  { length: 12 },
  (_, index) => `4b1e7c2a-3d5f-4e6a-9b8c-0d1e2f3a4c${String(index).padStart(2, "0")}`,
);
const id = (index: number): string => ids[index] ?? "";

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

const total = async (): Promise<string | undefined> =>
  (
    await psql(
      `select sum(quantity) from private.goal_entries where goal_id = '${GOAL}' and status = 'active';`,
    )
  )[0];

async function cleanUp(): Promise<void> {
  // Goals and their entries go with the Home (on delete cascade).
  await psql(`delete from public.homes where id = '${HOME}';`);
}

beforeAll(async () => {
  await cleanUp();
  await psql(`begin;
insert into public.homes (id, name, timezone, created_by, creation_request_id)
  values ('${HOME}', 'Spaarhuis', 'Europe/Brussels', ${user("alice")}, gen_random_uuid());
insert into public.home_memberships (home_id, user_id, role) values
  ('${HOME}', ${user("alice")}, 'owner'), ('${HOME}', ${user("bob")}, 'member');
insert into private.goals (id, owner_home_id, kind, title, target, unit, unit_kind, created_by) values
  ('${GOAL}', '${HOME}', 'measurable', 'Vakantie', 100, 'km', 'preset', ${user("alice")});
insert into private.goal_entries (id, goal_id, kind, quantity, unit, unit_kind, contributed_by, source) values
  ('${id(0)}', '${GOAL}', 'initial', 10, 'km', 'preset', ${user("alice")}, 'app');
commit;`);
});
afterAll(cleanUp);

describe("simultaneous goal progress", () => {
  it("counts both of two contributions made at once, exactly", async () => {
    const results = await Promise.all(
      (
        [
          ["alice", id(1), "0.1"],
          ["bob", id(2), "0.2"],
        ] as const
      ).map(([name, entry, quantity]) =>
        as(
          name,
          `select public.add_goal_entry('${entry}', '${GOAL}', 'add', ${quantity}) ->> 'outcome';
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome)).toEqual(["added", "added"]);
    expect(await total()).toBe("10.300");
  });

  it("counts a contribution id that arrives twice at once only once", async () => {
    const results = await Promise.all(
      ["bob", "bob"].map((name) =>
        as(
          name,
          `select public.add_goal_entry('${id(3)}', '${GOAL}', 'add', 5) ->> 'outcome';
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["added", "exists"]);
    expect(await total()).toBe("15.300");
  });

  it("never lets a set total overwrite a contribution made at the same moment", async () => {
    // Alice saw 15.3 and sets the total to 20; Bob adds 1 at the same time.
    const results = await Promise.all([
      as(
        "alice",
        `select public.add_goal_entry('${id(4)}', '${GOAL}', 'total', 20, null, 'app', 15.3) ->> 'outcome';
select pg_sleep(0.3);`,
      ),
      as(
        "bob",
        `select public.add_goal_entry('${id(5)}', '${GOAL}', 'add', 1) ->> 'outcome';
select pg_sleep(0.3);`,
      ),
    ]);
    const [setTotal] = results[0];
    expect(results[1][0]).toBe("added");
    expect(["adjusted", "stale"]).toContain(setTotal);
    // Set first: 20, then Bob's 1 on top. Bob first: Alice's 15.3 is stale, so 16.3 stays.
    expect(await total()).toBe(setTotal === "adjusted" ? "21.000" : "16.300");
  });

  it("records one achievement when two managers mark the goal achieved at once", async () => {
    await psql(`update private.goals set target = 10, revision = 7 where id = '${GOAL}';`);
    const results = await Promise.all(
      ["alice", "alice"].map((name) =>
        as(
          name,
          `select public.set_goal_achievement('${GOAL}', 7, true) ->> 'outcome';
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["achieved", "unchanged"]);
    const [count] = await psql(
      `select count(*) from private.goal_achievements where goal_id = '${GOAL}';`,
    );
    expect(count).toBe("1");
  });
});
