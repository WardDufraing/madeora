// S27: races the meal-planner functions must decide in the database. Two members plan a meal in the
// same empty slot at once (one meal, the other told it is occupied); a repeating meal starts while a
// single meal is placed on one of its days (never both silently); and the same week copy is sent
// twice at once (each meal copied once).
//
// Like the other concurrency tests this needs overlapping psql sessions, so the data is committed.
// It uses the seeded users and removes what it created afterwards; the database is a disposable
// local test database (architecture.md §25).
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const user = (name: string) => `(select id from auth.users where email = '${name}@madeora.test')`;
const HOME = "7d2b4ea6-9b5a-4f77-bc5a-4b8c3a2e4601";
const SERIES = "7d2b4ea6-9b5a-4f77-bc5a-4b8c3a2e4602";
const MEAL_A = "7d2b4ea6-9b5a-4f77-bc5a-4b8c3a2e4603";
const MEAL_B = "7d2b4ea6-9b5a-4f77-bc5a-4b8c3a2e4604";
const MEAL_C = "7d2b4ea6-9b5a-4f77-bc5a-4b8c3a2e4605";
const SOURCE = "7d2b4ea6-9b5a-4f77-bc5a-4b8c3a2e4606";
const COPY = "7d2b4ea6-9b5a-4f77-bc5a-4b8c3a2e4607";

const day = (offset: number) =>
  `((now() at time zone 'Europe/Brussels')::date + ${String(offset)})`;
// The Home's standard slot ids, read once it is opened (the API roles cannot read the table).
const slots = new Map<string, string>();
const slot = (key: string) => `'${slots.get(key) ?? ""}'::uuid`;

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
  // Slots, meals and series go with the Home (on delete cascade).
  await psql(`delete from public.homes where id = '${HOME}';`);
}

beforeAll(async () => {
  await cleanUp();
  await psql(`begin;
insert into public.homes (id, name, timezone, created_by, creation_request_id)
  values ('${HOME}', 'Etenshuis', 'Europe/Brussels', ${user("alice")}, gen_random_uuid());
insert into public.home_memberships (home_id, user_id, role) values
  ('${HOME}', ${user("alice")}, 'owner'), ('${HOME}', ${user("bob")}, 'member');
commit;`);
  const [opened] = await as(
    "alice",
    `select jsonb_array_length(public.get_meal_plan('${HOME}') -> 'slots');`,
  );
  expect(opened).toBe("3");
  const rows = await psql(
    `select standard_key || '=' || id from private.meal_slots where owner_home_id = '${HOME}';`,
  );
  for (const line of rows) {
    const [key, id] = line.split("=");
    if (key && id) slots.set(key, id);
  }
});
afterAll(cleanUp);

describe("simultaneous meal-planner changes", () => {
  it("places one meal when two members fill the same empty slot at once", async () => {
    const results = await Promise.all(
      (
        [
          ["alice", MEAL_A],
          ["bob", MEAL_B],
        ] as const
      ).map(([name, id]) =>
        as(
          name,
          `select outcome from public.create_meal_entry('${id}', ${day(3)}, ${slot("dinner")},
  '${HOME}', null, 'Soep ${name}');
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["created", "occupied"]);
    const [meals] = await psql(
      `select count(*) from private.meal_entries
  where slot_id = ${slot("dinner")} and on_date = ${day(3)} and deleted_at is null;`,
    );
    expect(meals).toBe("1");
  });

  it("never lets a repeating meal and a single meal take the same day silently", async () => {
    const [token] = await as(
      "alice",
      `select preview ->> 'token' from public.preview_meal_series(${slot("lunch")}, 'daily', null,
  ${day(5)}, '${HOME}', ${day(7)});`,
    );
    const results = await Promise.all([
      as(
        "alice",
        `select outcome from public.create_meal_series('${SERIES}', ${slot("lunch")}, 'daily', null,
  ${day(5)}, '${token ?? ""}', '${HOME}', ${day(7)}, null, 'Brood');
select pg_sleep(0.3);`,
      ),
      as(
        "bob",
        `select outcome from public.create_meal_entry('${MEAL_C}', ${day(6)}, ${slot("lunch")},
  '${HOME}', null, 'Salade');
select pg_sleep(0.3);`,
      ),
    ]);
    const outcomes = results.map(([outcome]) => outcome).sort();
    // Whichever ran first wins; the other is told (the series' token is stale, or the day is taken).
    expect([
      ["conflicts", "created"],
      ["created", "occupied"],
    ]).toContainEqual(outcomes);
    const [shown] = await as(
      "alice",
      `select (select count(*) from jsonb_array_elements(p -> 'entries') x
    where (x ->> 'date')::date = ${day(6)} and (x ->> 'slotId')::uuid = ${slot("lunch")})
  + (select count(*) from jsonb_array_elements(p -> 'occurrences') x
    where (x ->> 'date')::date = ${day(6)} and (x ->> 'slotId')::uuid = ${slot("lunch")})
  from public.get_meal_plan('${HOME}', ${day(6)}, ${day(6)}) p;`,
    );
    expect(shown).toBe("1");
  });

  it("copies each meal once when the same week copy is sent twice at once", async () => {
    await as(
      "alice",
      `select outcome from public.create_meal_entry('${SOURCE}', ${day(14)}, ${slot("breakfast")},
  '${HOME}', null, 'Pap');`,
    );
    const [token] = await as(
      "alice",
      `select preview ->> 'token' from public.preview_meal_copy(${day(14)}, ${day(21)}, '${HOME}');`,
    );
    const copy = `select r ->> 'outcome' from public.copy_meal_week(${day(14)}, ${day(21)}, '${token ?? ""}',
  jsonb_build_array(jsonb_build_object('key', 'e:${SOURCE}', 'id', '${COPY}')), '${HOME}') c,
  jsonb_array_elements(c.results) r;
select pg_sleep(0.3);`;
    const results = await Promise.all([as("alice", copy), as("alice", copy)]);
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["created", "exists"]);
    const [copies] = await psql(
      `select count(*) from private.meal_entries where on_date = ${day(21)}
  and slot_id = ${slot("breakfast")} and deleted_at is null;`,
    );
    expect(copies).toBe("1");
  });
});
