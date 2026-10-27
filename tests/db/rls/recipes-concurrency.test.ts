// S24: races the recipe functions must decide in the database. Two members open the editor of the
// same recipe at the same moment (exactly one gets the lock); a double publish of one draft (one
// recipe, published once); and a save racing the editor's own departure from the Home (the save
// either lands before the departure or is refused after it, never a deadlock and never a save by a
// former member).
//
// Like the other concurrency tests this needs overlapping psql sessions, so the data is committed.
// It uses the seeded users and removes what it created afterwards; the database is a disposable
// local test database (architecture.md §25).
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const user = (name: string) => `(select id from auth.users where email = '${name}@madeora.test')`;
const HOME = "5b0f2c84-7f38-4d55-9a3e-2f6a1e0c2401";
const RECIPE = "5b0f2c84-7f38-4d55-9a3e-2f6a1e0c2402";
const DRAFT = "5b0f2c84-7f38-4d55-9a3e-2f6a1e0c2403";
const content = `'{"name": "Stoofvlees", "servings": 4, "servingsLabel": null, "prepMinutes": null,
  "cookMinutes": 180, "notes": null, "tags": [], "ingredients": [], "steps": ["Stoof."],
  "coverFileId": null}'::jsonb`;

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
  await psql(`delete from public.homes where id = '${HOME}';
delete from private.recipes where id in ('${RECIPE}', '${DRAFT}');`);
}

beforeAll(async () => {
  await cleanUp();
  // Alice owns the Home; Bob is a Member who created the recipe, so both may edit it.
  await psql(`begin;
insert into public.homes (id, name, timezone, created_by, creation_request_id)
  values ('${HOME}', 'Racehuis', 'Europe/Brussels', ${user("alice")}, gen_random_uuid());
insert into public.home_memberships (home_id, user_id, role) values
  ('${HOME}', ${user("alice")}, 'owner'), ('${HOME}', ${user("bob")}, 'member');
commit;`);
  const [created] = await as(
    "bob",
    `select outcome from public.create_recipe('${RECIPE}', ${content}, '${HOME}', true);`,
  );
  expect(created).toBe("created");
});
afterAll(cleanUp);

describe("simultaneous recipe changes", () => {
  it("gives the editing lock to exactly one of two members opening the editor at once", async () => {
    const results = await Promise.all(
      ["alice", "bob"].map((name) =>
        as(
          name,
          `select outcome from public.acquire_recipe_lock('${RECIPE}', gen_random_uuid());
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["acquired", "locked"]);
    const [locks] = await psql(
      `select count(*) from private.recipe_edit_locks where recipe_id = '${RECIPE}';`,
    );
    expect(locks).toBe("1");
    await psql(`delete from private.recipe_edit_locks where recipe_id = '${RECIPE}';`);
  });

  it("publishes a draft once when the publish arrives twice at once", async () => {
    const [draft] = await as(
      "carol",
      `select outcome from public.create_recipe('${DRAFT}', ${content});`,
    );
    expect(draft).toBe("created");
    const results = await Promise.all(
      [0, 1].map(() =>
        as(
          "carol",
          `select outcome from public.publish_recipe('${DRAFT}', 1, gen_random_uuid());
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["already_published", "published"]);
    const [state] = await psql(
      `select status || ':' || revision from private.recipes where id = '${DRAFT}';`,
    );
    expect(state).toBe("published:2");
  });

  it("never lets a member save after leaving, and never deadlocks", async () => {
    const [lock] = await as(
      "bob",
      `select outcome from public.acquire_recipe_lock('${RECIPE}', '5b0f2c84-7f38-4d55-9a3e-2f6a1e0c24ff');`,
    );
    expect(lock).toBe("acquired");
    const [[saved], [left]] = await Promise.all([
      as(
        "bob",
        `select outcome from public.update_recipe('${RECIPE}', 1, ${content},
  '5b0f2c84-7f38-4d55-9a3e-2f6a1e0c24ff');
select pg_sleep(0.3);`,
      ),
      as("bob", `select public.leave_home('${HOME}');`),
    ]);
    expect(left).toBe("left");
    expect(["saved", "not_found"]).toContain(saved);
    const [after] = await psql(
      `select count(*) from private.recipe_edit_locks where recipe_id = '${RECIPE}';`,
    );
    expect(after).toBe("0");
    const [members] = await psql(
      `select count(*) from public.home_memberships where home_id = '${HOME}' and user_id = ${user("bob")};`,
    );
    expect(members).toBe("0");
  });
});
