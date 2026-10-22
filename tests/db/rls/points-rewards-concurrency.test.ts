// S23: points and rewards under simultaneous requests. Two redemptions racing for the last points
// spend them once; two requests racing for the last capacity reserve it once; an approval racing a
// cancellation, two approvals at once, an adjustment racing a redemption and an approval racing the
// requester's departure each end in one consistent state, with available points never below zero
// and every reservation released or converted exactly once; two reviewers approving the same chore
// completion pay its points once.
//
// Like chores-concurrency.test.ts this needs overlapping psql sessions, so the data is committed. It
// creates one Home for the seeded users Alice (Owner), Bob (Administrator granted approveHomeRewards
// and approveHomeChores) and Carol (Member) and deletes it and everything it produced afterwards;
// the database is a disposable local test database (architecture.md §25).
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const alice = "(select id from auth.users where email = 'alice@madeora.test')";
const bob = "(select id from auth.users where email = 'bob@madeora.test')";
const carol = "(select id from auth.users where email = 'carol@madeora.test')";
const homeName = "Points Race Home";
const home = `(select id from public.homes where name = '${homeName}')`;
const today = "(now() at time zone 'Europe/Brussels')::date";

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
  await psql(`delete from public.notifications where home_id = ${home};
    delete from private.job_outbox o where (o.payload ->> 'notificationId')::uuid in (
      select n.id from public.notifications n where n.home_id = ${home});
    delete from private.audit_events where home_id = ${home};
    delete from public.homes where name = '${homeName}';`);
}

/** Runs `sql` as a signed-in user; the first output line is set_config's, the rest are the script's. */
async function as(user: string, sql: string): Promise<string[]> {
  const [claims] = await psql(
    `select json_build_object('sub', ${user}, 'role', 'authenticated')::text;`,
  );
  const lines = await psql(`begin;
set local role authenticated;
select set_config('request.jwt.claims', '${claims ?? ""}', true);
${sql}
commit;`);
  return lines.slice(1);
}

async function member(user: string): Promise<string> {
  const [id = ""] = await psql(
    `select id from public.home_memberships where home_id = ${home} and user_id = ${user};`,
  );
  return `'${id}'`;
}

async function uuid(): Promise<string> {
  const [id = ""] = await psql(`select gen_random_uuid();`);
  return id;
}

/** Gives `user` exactly `amount` available points (a bonus or correction by Alice). */
async function fund(user: string, amount: number): Promise<void> {
  const [available = "0"] = await psql(`select coalesce((select balance - reserved
    from private.point_accounts where home_id = ${home} and user_id = ${user}), 0);`);
  const delta = amount - Number(available);
  if (delta === 0) return;
  const [outcome] = await as(
    alice,
    `select outcome from public.adjust_points(gen_random_uuid(), ${home}, ${await member(user)},
      '${delta > 0 ? "bonus" : "correction"}', ${String(delta)}, 'Test funding');`,
  );
  expect(outcome).toBe("posted");
}

async function newReward(cost: number, extra = ""): Promise<string> {
  const id = await uuid();
  const [outcome] = await as(
    alice,
    `select outcome from public.create_reward('${id}', ${home}, 'Reward ${id.slice(0, 8)}', ${String(cost)}${extra});`,
  );
  expect(outcome).toBe("created");
  return id;
}

async function account(user: string): Promise<{ available: number; reserved: number }> {
  const [row = "0|0"] = await psql(`select balance - reserved || '|' || reserved
    from private.point_accounts where home_id = ${home} and user_id = ${user};`);
  const [available = "0", reserved = "0"] = row.split("|");
  return { available: Number(available), reserved: Number(reserved) };
}

async function count(sql: string): Promise<number> {
  const [value = "0"] = await psql(sql);
  return Number(value);
}

async function revision(redemption: string): Promise<string> {
  const [value = ""] = await psql(
    `select revision from private.reward_redemptions where id = '${redemption}';`,
  );
  return value;
}

beforeAll(async () => {
  await cleanUp();
  await psql(`begin;
    insert into public.homes (name, timezone, created_by, creation_request_id)
      values ('${homeName}', 'Europe/Brussels', ${alice}, gen_random_uuid());
    insert into public.home_memberships (home_id, user_id, role) values
      (${home}, ${alice}, 'owner'), (${home}, ${bob}, 'administrator'), (${home}, ${carol}, 'member');
    insert into private.home_admin_capabilities (home_id, user_id, capability) values
      (${home}, ${bob}, 'approveHomeRewards'), (${home}, ${bob}, 'approveHomeChores');
    commit;`);
});
afterAll(cleanUp);

describe("two redemptions racing for the last points", () => {
  it("spend them once, every time", async () => {
    for (let round = 0; round < 4; round += 1) {
      await fund(carol, 20);
      const [first, second] = [await newReward(20), await newReward(20)];
      const results = await Promise.all(
        [first, second].map(async (reward) =>
          as(
            carol,
            `select outcome from public.redeem_reward('${await uuid()}', '${reward}', 20);
select pg_sleep(0.3);`,
          ),
        ),
      );
      expect(results.map(([outcome]) => outcome).sort()).toEqual([
        "insufficient_points",
        "redeemed",
      ]);
      expect(await account(carol)).toEqual({ available: 0, reserved: 0 });
    }
  });
});

describe("two members racing for the last capacity", () => {
  it("reserve it once", async () => {
    await fund(carol, 50);
    await fund(alice, 50);
    const reward = await newReward(10, ", p_requires_approval => true, p_total_limit => 1");
    const results = await Promise.all(
      [carol, alice].map(async (user) =>
        as(
          user,
          `select outcome from public.redeem_reward('${await uuid()}', '${reward}', 10);
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["requested", "sold_out"]);
    expect(
      await count(`select count(*) from private.reward_redemptions where reward_id = '${reward}'`),
    ).toBe(1);
    // Whoever won, the Owner cancels the request so later races start from the same balances.
    const [winner = ""] = await psql(
      `select id from private.reward_redemptions where reward_id = '${reward}';`,
    );
    const [cancelled] = await as(
      alice,
      `select outcome from public.cancel_reward_redemption('${winner}', ${await revision(winner)},
        'Clearing the race');`,
    );
    expect(cancelled).toBe("cancelled");
  });
});

describe("an approval racing a cancellation", () => {
  it("applies once and releases or converts the reservation once", async () => {
    await fund(carol, 30);
    const reward = await newReward(30, ", p_requires_approval => true");
    const redemption = await uuid();
    const [requested] = await as(
      carol,
      `select outcome from public.redeem_reward('${redemption}', '${reward}', 30);`,
    );
    expect(requested).toBe("requested");
    const rev = await revision(redemption);
    const [approve, cancel] = await Promise.all([
      as(
        bob,
        `select outcome from public.review_reward_redemption('${redemption}', ${rev}, 'approve');
select pg_sleep(0.3);`,
      ),
      as(
        carol,
        `select outcome from public.cancel_reward_redemption('${redemption}', ${rev});
select pg_sleep(0.3);`,
      ),
    ]);
    const outcomes = [approve[0], cancel[0]].sort();
    const entries = await count(
      `select count(*) from private.point_entries where redemption_id = '${redemption}'`,
    );
    if (approve[0] === "approved") {
      expect(outcomes).toEqual(["approved", "not_pending"]);
      expect(entries).toBe(1);
      expect(await account(carol)).toEqual({ available: 0, reserved: 0 });
    } else {
      expect(outcomes.sort()).toEqual(["cancelled", "not_pending"]);
      expect(entries).toBe(0);
      expect(await account(carol)).toEqual({ available: 30, reserved: 0 });
    }
  });
});

describe("two reviewers approving at once", () => {
  it("deduct once", async () => {
    await fund(carol, 25);
    const reward = await newReward(25, ", p_requires_approval => true");
    const redemption = await uuid();
    await as(carol, `select outcome from public.redeem_reward('${redemption}', '${reward}', 25);`);
    const rev = await revision(redemption);
    const results = await Promise.all(
      [alice, bob].map((user) =>
        as(
          user,
          `select outcome from public.review_reward_redemption('${redemption}', ${rev}, 'approve');
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["approved", "not_pending"]);
    expect(
      await count(
        `select count(*) from private.point_entries where redemption_id = '${redemption}'`,
      ),
    ).toBe(1);
    expect(await account(carol)).toEqual({ available: 0, reserved: 0 });
  });
});

describe("an adjustment racing a redemption", () => {
  it("never takes available points below zero", async () => {
    await fund(carol, 20);
    const reward = await newReward(20);
    const carolMember = await member(carol);
    const [debit, redeem] = await Promise.all([
      as(
        alice,
        `select outcome from public.adjust_points(gen_random_uuid(), ${home}, ${carolMember},
          'correction', -20, 'Race correction');
select pg_sleep(0.3);`,
      ),
      as(
        carol,
        `select outcome from public.redeem_reward('${await uuid()}', '${reward}', 20);
select pg_sleep(0.3);`,
      ),
    ]);
    expect([debit[0], redeem[0]].filter((o) => o === "posted" || o === "redeemed")).toHaveLength(1);
    expect([debit[0], redeem[0]].filter((o) => o === "insufficient_points")).toHaveLength(1);
    expect(await account(carol)).toEqual({ available: 0, reserved: 0 });
  });
});

describe("an approval racing the requester's departure", () => {
  it("ends redeemed or cancelled, with the reservation settled once", async () => {
    await fund(carol, 15);
    const reward = await newReward(15, ", p_requires_approval => true");
    const redemption = await uuid();
    await as(carol, `select outcome from public.redeem_reward('${redemption}', '${reward}', 15);`);
    const rev = await revision(redemption);
    const [approve, leave] = await Promise.all([
      as(
        bob,
        `select outcome from public.review_reward_redemption('${redemption}', ${rev}, 'approve');
select pg_sleep(0.3);`,
      ),
      as(
        carol,
        `select public.leave_home(${home});
select pg_sleep(0.3);`,
      ),
    ]);
    expect(leave[0]).toBe("left");
    const [status = ""] = await psql(
      `select status from private.reward_redemptions where id = '${redemption}';`,
    );
    const entries = await count(
      `select count(*) from private.point_entries where redemption_id = '${redemption}'`,
    );
    if (approve[0] === "approved") {
      expect(status).toBe("redeemed");
      expect(entries).toBe(1);
      expect(await account(carol)).toEqual({ available: 0, reserved: 0 });
    } else {
      expect(["not_found", "not_pending", "requester_unavailable"]).toContain(approve[0]);
      expect(status).toBe("cancelled");
      expect(entries).toBe(0);
      expect(await account(carol)).toEqual({ available: 15, reserved: 0 });
    }
    // Carol comes back for the remaining cases.
    await psql(
      `insert into public.home_memberships (home_id, user_id, role) values (${home}, ${carol}, 'member');`,
    );
  });
});

describe("two reviewers approving the same chore completion", () => {
  it("pay its points once", async () => {
    const chore = await uuid();
    const [created] = await as(
      alice,
      `select outcome from public.create_chore('${chore}', ${home}, 'Race chore',
        '{"mode": "none", "members": []}', p_due_date => ${today}, p_points => 12,
        p_requires_approval => true);`,
    );
    expect(created).toBe("created");
    const [occurrence = ""] = await psql(
      `select id from private.chore_occurrences where chore_id = '${chore}';`,
    );
    const [submitted] = await as(
      carol,
      `select outcome from public.complete_chore_occurrence('${occurrence}', ${await member(carol)});`,
    );
    expect(submitted).toBe("submitted");
    const [rev = ""] = await psql(
      `select revision from private.chore_occurrences where id = '${occurrence}';`,
    );
    const results = await Promise.all(
      [alice, bob].map((user) =>
        as(
          user,
          `select outcome from public.review_chore_submission('${occurrence}', ${rev}, 'approve');
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["approved", "not_pending"]);
    expect(
      await count(`select count(*) from private.point_entries where occurrence_id = '${occurrence}'
        and kind = 'chore_award'`),
    ).toBe(1);
  });
});
