// S17: two devices saving the same dashboard at the same moment. Each save names the revision it
// started from; the database lets exactly one of them through and answers the other with a conflict,
// so neither silently overwrites the other (the first save of a new account included, which races on
// the row's unique index instead of a revision).
//
// Like trash-concurrency.test.ts this needs overlapping psql sessions, so the data is committed. It
// uses the seeded user Carol and deletes her layout afterwards; the database is a disposable local
// test database (architecture.md §25).
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const carol = "(select id from auth.users where email = 'carol@madeora.test')";
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

async function cleanUp(): Promise<void> {
  await psql(`delete from private.dashboard_layouts where owner_user_id = ${carol};`);
}

async function asCarol(sql: string): Promise<string[]> {
  const [claims] = await psql(
    `select json_build_object('sub', ${carol}, 'role', 'authenticated')::text;`,
  );
  return psql(`begin;
set local role authenticated;
select set_config('request.jwt.claims', '${claims ?? ""}', true);
${sql}
commit;`);
}

beforeAll(cleanUp);
afterAll(cleanUp);

describe("simultaneous saves of one dashboard", () => {
  it("lets one first save through and reports the other as a conflict", async () => {
    const results = await Promise.all(
      [0, 1].map(() =>
        asCarol(`select outcome from public.save_dashboard(${layout}, 0);
select pg_sleep(0.3);`),
      ),
    );
    expect(results.map(([, outcome]) => outcome).sort()).toEqual(["conflict", "saved"]);
    const [rows] = await psql(
      `select count(*) from private.dashboard_layouts where owner_user_id = ${carol};`,
    );
    expect(rows).toBe("1");
  });

  it("lets one later save through and reports the other as a conflict", async () => {
    const results = await Promise.all(
      [0, 1].map(() =>
        asCarol(`select outcome from public.save_dashboard(${layout}, 1);
select pg_sleep(0.3);`),
      ),
    );
    expect(results.map(([, outcome]) => outcome).sort()).toEqual(["conflict", "saved"]);
    const [revision] = await psql(
      `select revision from private.dashboard_layouts where owner_user_id = ${carol};`,
    );
    expect(revision).toBe("2");
  });
});
