// S28b: races the personal ledger must decide in the database. Two redemptions race for the last
// points (one spends, the other is told insufficient_points); the same credit is sent twice at once
// (one entry); the same reversal and the same refund are confirmed twice at once (each posts once).
// Every change locks the owner's account row first, so the cached balance always equals the ledger.
//
// Like the other concurrency tests this needs overlapping psql sessions, so the data is committed.
// It uses the seeded user Alice, who needs no Home, and removes what it created afterwards; the
// database is a disposable local test database (architecture.md §25).
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const alice = "(select id from auth.users where email = 'alice@madeora.test')";
const CREDIT = "5b1e8a52-2f0d-4c37-9a61-7d3f0c2b8a01";
const REWARD_A = "5b1e8a52-2f0d-4c37-9a61-7d3f0c2b8a02";
const REWARD_B = "5b1e8a52-2f0d-4c37-9a61-7d3f0c2b8a03";
const REDEEM_A = "5b1e8a52-2f0d-4c37-9a61-7d3f0c2b8a04";
const REDEEM_B = "5b1e8a52-2f0d-4c37-9a61-7d3f0c2b8a05";
const RETRY = "5b1e8a52-2f0d-4c37-9a61-7d3f0c2b8a06";
const REVERSIBLE = "5b1e8a52-2f0d-4c37-9a61-7d3f0c2b8a07";

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

async function asAlice(sql: string): Promise<string[]> {
  const [claims] = await psql(
    `select json_build_object('sub', ${alice}, 'role', 'authenticated')::text;`,
  );
  // The first line is set_config's own answer.
  const lines = await psql(`begin;
set local role authenticated;
select set_config('request.jwt.claims', '${claims ?? ""}', true);
${sql}
commit;`);
  return lines.slice(1);
}

async function balance(): Promise<{ cached: string; ledger: string }> {
  const [row] = await psql(
    `select a.balance || '|' || coalesce((select sum(e.amount) from private.personal_point_entries e
  where e.user_id = a.user_id), 0) from private.personal_point_accounts a where a.user_id = ${alice};`,
  );
  const [cached = "", ledger = ""] = (row ?? "|").split("|");
  return { cached, ledger };
}

async function cleanUp(): Promise<void> {
  // Entries, rewards and redemptions go with the account (on delete cascade).
  await psql(`delete from private.personal_point_accounts where user_id = ${alice};`);
}

beforeAll(async () => {
  await cleanUp();
  // 10 points and two rewards of 10 each: only one can be redeemed.
  await asAlice(`select outcome from public.adjust_personal_points('${CREDIT}', 'credit', 10, 'Start balance');
select outcome from public.create_personal_reward('${REWARD_A}', 'Book', 10);
select outcome from public.create_personal_reward('${REWARD_B}', 'Film', 10);`);
});
afterAll(cleanUp);

describe("simultaneous personal ledger changes", () => {
  it("lets only one of two redemptions spend the last points", async () => {
    const results = await Promise.all(
      [
        [REDEEM_A, REWARD_A],
        [REDEEM_B, REWARD_B],
      ].map(([id, reward]) =>
        asAlice(`select outcome from public.redeem_personal_reward('${id ?? ""}', '${reward ?? ""}', 10);
select pg_sleep(0.3);`),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["insufficient_points", "redeemed"]);
    expect(await balance()).toEqual({ cached: "0", ledger: "0" });
  });

  it("posts a credit sent twice at once only once", async () => {
    const results = await Promise.all(
      [1, 2].map(() =>
        asAlice(`select outcome from public.adjust_personal_points('${RETRY}', 'credit', 7, 'Sent twice');
select pg_sleep(0.3);`),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["exists", "posted"]);
    expect(await balance()).toEqual({ cached: "7", ledger: "7" });
  });

  it("reverses an entry once when the reversal is confirmed twice at once", async () => {
    await asAlice(
      `select outcome from public.adjust_personal_points('${REVERSIBLE}', 'credit', 3, 'To undo');`,
    );
    const results = await Promise.all(
      [1, 2].map(() =>
        asAlice(`select outcome from public.reverse_personal_point_entry('${REVERSIBLE}', 'Undo it');
select pg_sleep(0.3);`),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["already_reversed", "reversed"]);
    expect(await balance()).toEqual({ cached: "7", ledger: "7" });
  });

  it("refunds an Unable-to-fulfill redemption once when the refund is confirmed twice", async () => {
    const [redeemed] = await psql(
      `select id from private.personal_reward_redemptions where user_id = ${alice};`,
    );
    const id = redeemed ?? "";
    await asAlice(
      `select outcome from public.set_personal_reward_fulfillment('${id}', 1, 'unable');`,
    );
    const results = await Promise.all(
      [1, 2].map(() =>
        asAlice(`select outcome from public.resolve_personal_reward_redemption('${id}', 2, 'refund');
select pg_sleep(0.3);`),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["already_resolved", "resolved"]);
    const [refunds] = await psql(
      `select count(*) from private.personal_point_entries
  where user_id = ${alice} and kind = 'refund' and redemption_id = '${id}';`,
    );
    expect(refunds).toBe("1");
    expect(await balance()).toEqual({ cached: "17", ledger: "17" });
  });
});
