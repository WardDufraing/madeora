// UX2-data: two devices committing a personal Home view, or a history restore racing a save, at the
// same moment. Exactly one commit goes through, the other is a conflict, and history gets exactly one
// version per committed revision.
//
// Like dashboards-concurrency.test.ts this needs overlapping psql sessions, so the data is committed.
// It creates a Home for the seeded user Alice with Carol as a Member and deletes it (and Carol's
// personal layout) afterwards; the database is a disposable local test database (architecture.md §25).
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const user = (name: string): string =>
  `(select id from auth.users where email = '${name}@madeora.test')`;
const homeName = "UX2 concurrency";
const home = `(select id from public.homes where name = '${homeName}')`;
const layout = `'{"version": 1, "widgets": [], "placements": {"lg": [], "md": [], "sm": []}}'::jsonb`;

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
  return psql(`begin;
set local role authenticated;
select set_config('request.jwt.claims', '${claims ?? ""}', true);
${sql}
commit;`);
}

async function cleanUp(): Promise<void> {
  await psql(`delete from public.homes where name = '${homeName}';
delete from private.dashboard_layouts where owner_user_id = ${user("carol")};`);
}

beforeAll(async () => {
  await cleanUp();
  await as(
    "alice",
    `select public.create_home('${homeName}', 'Europe/Brussels', gen_random_uuid());`,
  );
  await psql(`insert into public.home_memberships (home_id, user_id, role)
  values (${home}, ${user("carol")}, 'member');`);
});
afterAll(cleanUp);

describe("simultaneous commits of a personal Home view", () => {
  it("lets one first save through and reports the other as a conflict", async () => {
    const results = await Promise.all(
      [0, 1].map(() =>
        as(
          "carol",
          `select outcome from public.save_dashboard(${layout}, 0, ${home}, null, 'mine');
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([, outcome]) => outcome).sort()).toEqual(["conflict", "saved"]);
    const [views, versions] = await psql(
      `select count(*) from private.dashboard_member_overrides where user_id = ${user("carol")};
select count(*) from private.dashboard_layout_versions v
  join private.dashboard_member_overrides o on o.id = v.override_id
  where o.user_id = ${user("carol")};`,
    );
    expect(views).toBe("1");
    expect(versions).toBe("1");
  });
});

describe("a history restore racing a save", () => {
  it("lets exactly one through and records one version per revision", async () => {
    await as(
      "carol",
      `select public.save_dashboard(${layout}, 0);
select public.save_dashboard(${layout}, 1);`,
    );
    const [, versionId] = await as(
      "carol",
      `select version_id from public.list_dashboard_versions() where revision = 1;`,
    );
    const results = await Promise.all([
      as(
        "carol",
        `select outcome from public.restore_dashboard_version('${versionId ?? ""}', 2);
select pg_sleep(0.3);`,
      ),
      as(
        "carol",
        `select outcome from public.save_dashboard(${layout}, 2);
select pg_sleep(0.3);`,
      ),
    ]);
    expect(results.map(([, outcome]) => outcome).sort()).toEqual(["conflict", "saved"]);
    const [revision, versions] = await psql(
      `select revision from private.dashboard_layouts where owner_user_id = ${user("carol")};
select count(*) from private.dashboard_layout_versions v
  join private.dashboard_layouts d on d.id = v.layout_id
  where d.owner_user_id = ${user("carol")};`,
    );
    expect(revision).toBe("3");
    expect(versions).toBe("3");
  });
});
