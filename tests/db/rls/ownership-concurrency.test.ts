// S12: simultaneous ownership transfers, acceptances, removals and departures never leave a Home
// with no Owner or two (spec "Confirmed exactly one Home Owner": "concurrent transfer attempts;
// recipient losing membership before acceptance"; removal reaffirmation: "concurrent role change
// during confirmation").
//
// Like invitations-concurrency.test.ts, this needs two psql sessions whose transactions overlap, so
// its setup is committed. Every row it creates uses fresh random ids and is deleted afterwards; the
// database is a disposable local test database (architecture.md §25).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();

/** Runs a psql script in its own session; resolves with the rows it printed. */
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

/** Runs `sql` as `userId` through the API role in one transaction, holding it open a moment. */
async function asUser(userId: string, sql: string, holdSeconds = 0): Promise<string[]> {
  return psql(`begin;
set local role authenticated;
do $$ begin
  perform set_config('request.jwt.claims', '{"sub": "${userId}", "role": "authenticated"}', true);
end $$;
${sql}
${holdSeconds > 0 ? `select null from pg_sleep(${String(holdSeconds)});` : ""}
commit;`);
}

const owner = randomUUID();
const alex = randomUUID();
const sam = randomUUID();
const everyone = [owner, alex, sam];
const homes: string[] = [];
let homeId = "";

/** A fresh Home: the owner is Owner, Alex an Administrator, Sam a Member. */
beforeEach(async () => {
  if (homes.length === 0) {
    const users = everyone
      .map(
        (id) => `('00000000-0000-0000-0000-000000000000', '${id}', 'authenticated', 'authenticated',
          'ownership-${id}@madeora.test', now(), now(), now())`,
      )
      .join(",\n");
    await psql(`insert into auth.users
      (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
      values ${users};`);
  }
  [homeId] = (await asUser(
    owner,
    `select public.create_home('Ownership', 'UTC', gen_random_uuid());`,
  )) as [string];
  homes.push(homeId);
  await psql(`insert into public.home_memberships (home_id, user_id, role) values
    ('${homeId}', '${alex}', 'administrator'), ('${homeId}', '${sam}', 'member');`);
});

afterAll(async () => {
  const list = homes.map((id) => `'${id}'`).join(", ");
  if (list) {
    await psql(`delete from public.homes where id in (${list});
      delete from private.audit_events where home_id in (${list});`);
  }
  await psql(`delete from auth.users where id in (${everyone.map((id) => `'${id}'`).join(", ")});`);
});

async function membershipId(userId: string): Promise<string> {
  const [id] = await psql(
    `select id from public.home_memberships where home_id = '${homeId}' and user_id = '${userId}';`,
  );
  if (!id) throw new Error("no membership");
  return id;
}

async function owners(): Promise<string[]> {
  return psql(
    `select user_id from public.home_memberships where home_id = '${homeId}' and role = 'owner';`,
  );
}

async function startTransfer(to: string): Promise<string> {
  const [transferId] = await asUser(
    owner,
    `select transfer_id from public.start_ownership_transfer('${homeId}', '${await membershipId(to)}',
       gen_random_uuid());`,
  );
  if (!transferId) throw new Error("no transfer");
  return transferId;
}

describe("simultaneous ownership changes", () => {
  it("lets only one of two simultaneous transfer starts through", async () => {
    const [alexId, samId] = [await membershipId(alex), await membershipId(sam)];
    const outcomes = await Promise.all(
      [alexId, samId].map((target) =>
        asUser(
          owner,
          `select outcome from public.start_ownership_transfer('${homeId}', '${target}', gen_random_uuid());`,
          0.5,
        ),
      ),
    );
    expect(outcomes.map(([outcome]) => outcome).sort()).toEqual(["pending_exists", "started"]);
  });

  it("never ends with no Owner or two when acceptance and removal of the recipient race", async () => {
    const transferId = await startTransfer(sam);
    const samId = await membershipId(sam);
    const [accept, remove] = await Promise.all([
      asUser(
        sam,
        `select public.respond_to_ownership_transfer('${homeId}', '${transferId}', 'accept');`,
        0.5,
      ),
      asUser(owner, `select public.remove_home_member('${homeId}', '${samId}', 'member');`, 0.5),
    ]);
    const outcomes = [accept[0], remove[0]];
    // Either the acceptance ran first (then the removal, confirmed for a Member who is now the
    // Owner, is refused as stale), or the removal did (then the recipient is no longer a member).
    expect([
      ["accepted", "stale"],
      ["not_found", "removed"],
    ]).toContainEqual(outcomes);
    const current = await owners();
    expect(current).toHaveLength(1);
    expect(current[0]).toBe(outcomes[0] === "accepted" ? sam : owner);
  });

  it("never ends with no Owner or two when acceptance and the recipient's departure race", async () => {
    const transferId = await startTransfer(alex);
    const [accept, leave] = await Promise.all([
      asUser(
        alex,
        `select public.respond_to_ownership_transfer('${homeId}', '${transferId}', 'accept');`,
        0.5,
      ),
      asUser(alex, `select public.leave_home('${homeId}');`, 0.5),
    ]);
    const outcomes = [accept[0], leave[0]];
    expect([
      ["accepted", "owner_must_transfer"],
      ["not_found", "left"],
    ]).toContainEqual(outcomes);
    expect(await owners()).toHaveLength(1);
  });

  it("lets acceptance or cancellation win, never both", async () => {
    const transferId = await startTransfer(sam);
    const [accept, cancel] = await Promise.all([
      asUser(
        sam,
        `select public.respond_to_ownership_transfer('${homeId}', '${transferId}', 'accept');`,
        0.5,
      ),
      asUser(owner, `select public.cancel_ownership_transfer('${homeId}', '${transferId}');`, 0.5),
    ]);
    const outcomes = [accept[0], cancel[0]];
    expect([
      ["accepted", "already_decided"],
      ["already_decided", "cancelled"],
    ]).toContainEqual(outcomes);
    const current = await owners();
    expect(current).toHaveLength(1);
    expect(current[0]).toBe(outcomes[0] === "accepted" ? sam : owner);
  });

  it("refuses a removal by an Administrator whose capability is revoked at the same moment", async () => {
    await asUser(
      owner,
      `select public.set_administrator_capabilities('${homeId}', '${await membershipId(alex)}',
         array['removeMembers']);`,
    );
    const samId = await membershipId(sam);
    const alexId = await membershipId(alex);
    const [revoke, remove] = await Promise.all([
      asUser(
        owner,
        `select public.set_administrator_capabilities('${homeId}', '${alexId}', array[]::text[]);`,
        0.5,
      ),
      asUser(alex, `select public.remove_home_member('${homeId}', '${samId}', 'member');`, 0.5),
    ]);
    const outcomes = [revoke[0], remove[0]];
    expect([
      ["ok", "not_permitted"],
      ["ok", "removed"],
    ]).toContainEqual(outcomes);
    const [samStillThere] = await psql(
      `select count(*) from public.home_memberships where id = '${samId}';`,
    );
    // Whichever ran first decided; a removal never happens after the revocation committed.
    expect(samStillThere).toBe(outcomes[1] === "removed" ? "0" : "1");
  });

  it("the database refuses a second Owner and a Home without one, whatever path writes", async () => {
    await expect(
      psql(`update public.home_memberships set role = 'owner'
        where home_id = '${homeId}' and user_id = '${sam}';`),
    ).rejects.toThrow(/home_memberships_one_owner/);
    await expect(
      psql(`update public.home_memberships set role = 'member'
        where home_id = '${homeId}' and user_id = '${owner}';`),
    ).rejects.toThrow(/a Home must always have an Owner/);
    expect(await owners()).toEqual([owner]);
  });
});
