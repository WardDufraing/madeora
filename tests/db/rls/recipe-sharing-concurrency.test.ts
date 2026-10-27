// S25: races the recipe sharing functions must decide in the database. A share sent twice at once
// (one share); a delete racing a change to the shares it reviewed (either the delete lands first and
// pauses the shares, or the change lands first and the review is stale: never a deleted recipe with
// an active share); and a destination editor's save racing their departure from that Home (saved
// before, or refused after, never a deadlock).
//
// Like the other concurrency tests this needs overlapping psql sessions, so the data is committed.
// It uses the seeded users and removes what it created afterwards; the database is a disposable
// local test database (architecture.md §25).
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const user = (name: string) => `(select id from auth.users where email = '${name}@madeora.test')`;
const ORIGIN = "6c1f3d95-8a49-4e66-8b4f-3a7b2f1d3501";
const DESTINATION = "6c1f3d95-8a49-4e66-8b4f-3a7b2f1d3502";
const RECIPE = "6c1f3d95-8a49-4e66-8b4f-3a7b2f1d3503";
const OTHER = "6c1f3d95-8a49-4e66-8b4f-3a7b2f1d3504";
const TOKEN = "6c1f3d95-8a49-4e66-8b4f-3a7b2f1d35ff";
const content = `'{"name": "Hutspot", "servings": 4, "servingsLabel": null, "prepMinutes": null,
  "cookMinutes": 40, "notes": null, "tags": [], "ingredients": [], "steps": ["Stamp."],
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
  // A deleted recipe's trash entry queues its purge; the outbox tests need no due rows left behind.
  await psql(`delete from private.job_outbox o using private.trash_entries t
  where t.subject_id in ('${RECIPE}', '${OTHER}') and o.idempotency_key = 'trash-entry:' || t.id || ':purge';
delete from private.trash_entries where subject_id in ('${RECIPE}', '${OTHER}');
delete from private.recipes where id in ('${RECIPE}', '${OTHER}');
delete from public.homes where id in ('${ORIGIN}', '${DESTINATION}');`);
}

beforeAll(async () => {
  await cleanUp();
  // Alice owns both Homes; Bob is an Administrator of the destination granted manageHomeRecipes.
  await psql(`begin;
insert into public.homes (id, name, timezone, created_by, creation_request_id) values
  ('${ORIGIN}', 'Oorsprong', 'Europe/Brussels', ${user("alice")}, gen_random_uuid()),
  ('${DESTINATION}', 'Bestemming', 'Europe/Brussels', ${user("alice")}, gen_random_uuid());
insert into public.home_memberships (home_id, user_id, role) values
  ('${ORIGIN}', ${user("alice")}, 'owner'), ('${DESTINATION}', ${user("alice")}, 'owner'),
  ('${DESTINATION}', ${user("bob")}, 'administrator');
commit;`);
  const [membership] = await psql(
    `select id from public.home_memberships where home_id = '${DESTINATION}' and user_id = ${user("bob")};`,
  );
  await as(
    "alice",
    `select public.set_administrator_capabilities('${DESTINATION}', '${membership ?? ""}', array['manageHomeRecipes']);
select outcome from public.create_recipe('${RECIPE}', ${content}, '${ORIGIN}', true);
select outcome from public.create_recipe('${OTHER}', ${content}, '${ORIGIN}', true);`,
  );
});
afterAll(cleanUp);

describe("simultaneous recipe sharing changes", () => {
  it("makes one share when the same share arrives twice at once", async () => {
    const results = await Promise.all(
      [0, 1].map(() =>
        as(
          "alice",
          `select public.share_recipe('${RECIPE}', '${DESTINATION}', true);
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["shared", "unchanged"]);
    const [shares] = await psql(
      `select count(*) from private.recipe_shares where recipe_id = '${RECIPE}';`,
    );
    expect(shares).toBe("1");
  });

  it("never saves after the editor left the destination, and never deadlocks", async () => {
    const [lock] = await as(
      "bob",
      `select outcome from public.acquire_recipe_lock('${RECIPE}', '${TOKEN}', false, '${DESTINATION}');`,
    );
    expect(lock).toBe("acquired");
    const [[saved], [left]] = await Promise.all([
      as(
        "bob",
        `select outcome from public.update_recipe('${RECIPE}', 1, ${content}, '${TOKEN}');
select pg_sleep(0.3);`,
      ),
      as("bob", `select public.leave_home('${DESTINATION}');`),
    ]);
    expect(left).toBe("left");
    expect(["saved", "not_found"]).toContain(saved);
    const [locks] = await psql(
      `select count(*) from private.recipe_edit_locks where recipe_id = '${RECIPE}';`,
    );
    expect(locks).toBe("0");
  });

  it("never deletes a recipe while its reviewed shares change underneath", async () => {
    const [shared] = await as(
      "alice",
      `select public.share_recipe('${OTHER}', '${DESTINATION}', false);`,
    );
    expect(shared).toBe("shared");
    const [token] = await as(
      "alice",
      `select impact ->> 'token' from public.recipe_delete_impact('${OTHER}');`,
    );
    const [[deleted], [changed]] = await Promise.all([
      as(
        "alice",
        `select outcome from public.delete_recipe('${OTHER}', '${token ?? ""}');
select pg_sleep(0.3);`,
      ),
      as(
        "alice",
        `select public.share_recipe('${OTHER}', '${DESTINATION}', true);
select pg_sleep(0.3);`,
      ),
    ]);
    // Either order is fine; what may never happen is both succeeding.
    expect([
      ["deleted", "not_found"],
      ["stale_impact", "updated"],
    ]).toContainEqual([deleted, changed]);
    const [state] = await psql(
      `select count(*) from private.recipes r join private.recipe_shares s on s.recipe_id = r.id
  where r.id = '${OTHER}' and r.deleted_at is not null and s.suspended_at is null;`,
    );
    expect(state).toBe("0");
  });
});
