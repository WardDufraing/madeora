// S26: races the shopping functions must decide in the database. Two members check off the same item
// at the same moment (one completion, one event); two readers apply a due recurring item at once (one
// new item); the same item moved to two lists at once (it lands in exactly one); and two members
// reordering the same list's items at once (both moves apply, no deadlock, no lost item).
//
// Like the other concurrency tests this needs overlapping psql sessions, so the data is committed.
// It uses the seeded users and removes what it created afterwards; the database is a disposable
// local test database (architecture.md §25).
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const user = (name: string) => `(select id from auth.users where email = '${name}@madeora.test')`;
const HOME = "6c1a3d95-8a49-4e66-ab4f-3a7b2f1d3501";
const LIST = "6c1a3d95-8a49-4e66-ab4f-3a7b2f1d3502";
const LIST_2 = "6c1a3d95-8a49-4e66-ab4f-3a7b2f1d3503";
const LIST_3 = "6c1a3d95-8a49-4e66-ab4f-3a7b2f1d3504";
const MILK = "6c1a3d95-8a49-4e66-ab4f-3a7b2f1d3505";
const BREAD = "6c1a3d95-8a49-4e66-ab4f-3a7b2f1d3506";
const RULE = "6c1a3d95-8a49-4e66-ab4f-3a7b2f1d3507";
const EGGS = "6c1a3d95-8a49-4e66-ab4f-3a7b2f1d3508";
const TEA = "6c1a3d95-8a49-4e66-ab4f-3a7b2f1d3509";
const SOAP = "6c1a3d95-8a49-4e66-ab4f-3a7b2f1d350a";

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

const row = (id: string, name: string) =>
  `jsonb_build_object('id', '${id}', 'name', '${name}', 'quantity', null, 'unit', null,
    'packaging', null, 'notes', null, 'categoryId', null, 'allowDuplicate', false)`;

async function cleanUp(): Promise<void> {
  // The lists go with the Home (on delete cascade), their items and rules with them.
  await psql(`delete from public.homes where id = '${HOME}';`);
}

beforeAll(async () => {
  await cleanUp();
  await psql(`begin;
insert into public.homes (id, name, timezone, created_by, creation_request_id)
  values ('${HOME}', 'Winkelhuis', 'Europe/Brussels', ${user("alice")}, gen_random_uuid());
insert into public.home_memberships (home_id, user_id, role) values
  ('${HOME}', ${user("alice")}, 'owner'), ('${HOME}', ${user("bob")}, 'member');
commit;`);
  const created = await as(
    "alice",
    `select outcome from public.create_shopping_list('${LIST}', 'Boodschappen', '${HOME}');
select outcome from public.create_shopping_list('${LIST_2}', 'Markt', '${HOME}');
select outcome from public.create_shopping_list('${LIST_3}', 'Drogist', '${HOME}');
select outcome from public.add_shopping_items('${LIST}', jsonb_build_array(
  ${row(MILK, "Melk")}, ${row(BREAD, "Brood")}, ${row(EGGS, "Eieren")}, ${row(TEA, "Thee")},
  ${row(SOAP, "Zeep")}));`,
  );
  expect(created).toEqual([
    "created",
    "created",
    "created",
    "created",
    "created",
    "created",
    "created",
    "created",
  ]);
});
afterAll(cleanUp);

describe("simultaneous shopping changes", () => {
  it("records one completion when two members check the same item at once", async () => {
    const results = await Promise.all(
      ["alice", "bob"].map((name) =>
        as(
          name,
          `select outcome from public.set_shopping_item_completed('${MILK}', true);
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["completed", "unchanged"]);
    const [events] = await psql(
      `select count(*) from private.shopping_item_events where item_id = '${MILK}' and kind = 'completed';`,
    );
    expect(events).toBe("1");
  });

  it("makes one item when two readers apply a due recurring item at once", async () => {
    const [started] = await as(
      "alice",
      `select outcome from public.start_shopping_recurrence('${BREAD}', '${RULE}', 'daily');
select outcome from public.set_shopping_item_completed('${BREAD}', true);`,
    );
    expect(started).toBe("created");
    // Days went by unseen.
    await psql(
      `update private.shopping_recurrences set next_on = next_on - 3 where id = '${RULE}';`,
    );
    const results = await Promise.all(
      ["alice", "bob"].map((name) =>
        as(
          name,
          `select public.advance_shopping('${HOME}');
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([made]) => made).sort()).toEqual(["0", "1"]);
    const [active] = await psql(
      `select count(*) from private.shopping_items
  where recurrence_id = '${RULE}' and completed_at is null and deleted_at is null;`,
    );
    expect(active).toBe("1");
  });

  it("moves an item into exactly one list when it is moved to two at once", async () => {
    const results = await Promise.all(
      [LIST_2, LIST_3].map((destination, index) =>
        as(
          index === 0 ? "alice" : "bob",
          `select outcome from public.transfer_shopping_item('${EGGS}', 'move', '${destination}', 1);
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["conflict", "moved"]);
    const [lists] = await psql(`select count(*) from private.shopping_items where id = '${EGGS}';`);
    expect(lists).toBe("1");
  });

  it("applies two reorders of one list at once without losing or doubling an item", async () => {
    // The active items are now Thee, Zeep and the repeated Brood, in that order. Both move down, so
    // each still has a neighbour below whichever runs first.
    const results = await Promise.all([
      as(
        "alice",
        `select public.move_shopping_item('${SOAP}', 'down');
select pg_sleep(0.2);`,
      ),
      as(
        "bob",
        `select public.move_shopping_item('${TEA}', 'down');
select pg_sleep(0.2);`,
      ),
    ]);
    expect(results.map(([outcome]) => outcome)).toEqual(["saved", "saved"]);
    const [positions] = await psql(
      `select count(distinct position) || ':' || count(*) from private.shopping_items
  where list_id = '${LIST}' and deleted_at is null and completed_at is null;`,
    );
    expect(positions).toBe("3:3");
  });
});
