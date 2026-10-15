// S12b: completing a verified ownership recovery races the other ways a Home can change: the
// Owner removing the person who asked, the Owner opening the Home (showing they have access), an
// ordinary ownership transfer, and an objection. Whatever order the database settles on, the Home
// has exactly one Owner and a stale recovery never completes (spec "Confirmed verified Home
// ownership recovery": "revalidate everything at commit; atomic, exactly one Owner").
//
// Like ownership-concurrency.test.ts, this needs two psql sessions whose transactions overlap, so
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
let recoveryId = "";

/** A fresh Home (owner, Alex an Administrator, Sam a Member) with Sam's recovery ready to accept. */
beforeEach(async () => {
  if (homes.length === 0) {
    const users = everyone
      .map(
        (id) => `('00000000-0000-0000-0000-000000000000', '${id}', 'authenticated', 'authenticated',
          'recovery-${id}@madeora.test', now(), now(), now())`,
      )
      .join(",\n");
    await psql(`insert into auth.users
      (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
      values ${users};`);
  }
  [homeId] = (await asUser(
    owner,
    `select public.create_home('Recovery', 'UTC', gen_random_uuid());`,
  )) as [string];
  homes.push(homeId);
  await psql(`insert into public.home_memberships (home_id, user_id, role, created_at) values
    ('${homeId}', '${alex}', 'administrator', now() - interval '40 days'),
    ('${homeId}', '${sam}', 'member', now() - interval '40 days');`);
  [recoveryId] = (await psql(`insert into private.home_ownership_recoveries
    (home_id, claimant_id, owner_id, statement, status, creation_request_id, approved_at,
     objection_ends_at, former_owner_outcome)
    values ('${homeId}', '${sam}', '${owner}', repeat('The Owner cannot be reached. ', 3),
      'approved', gen_random_uuid(), now() - interval '15 days', now() - interval '1 day', 'member')
    returning id;`)) as [string];
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

async function caseStatus(): Promise<string | undefined> {
  const [status] = await psql(
    `select status from private.home_ownership_recoveries where id = '${recoveryId}';`,
  );
  return status;
}

function accept(holdSeconds = 0.5): Promise<string[]> {
  return asUser(
    sam,
    `select public.accept_ownership_recovery('${homeId}', '${recoveryId}');`,
    holdSeconds,
  );
}

describe("simultaneous recovery completion", () => {
  it("never completes for a person the Owner removes at the same moment", async () => {
    const samId = await membershipId(sam);
    const [accepted, removed] = await Promise.all([
      accept(),
      asUser(owner, `select public.remove_home_member('${homeId}', '${samId}', 'member');`, 0.5),
    ]);
    const outcomes = [accepted[0], removed[0]];
    // Either the handover ran first (then removing Sam, now the Owner, is refused as stale), or
    // the removal did (then the request ended with the membership).
    expect([
      ["completed", "stale"],
      ["no_longer_valid", "removed"],
    ]).toContainEqual(outcomes);
    const current = await owners();
    expect(current).toEqual([outcomes[0] === "completed" ? sam : owner]);
    expect(await caseStatus()).toBe(outcomes[0] === "completed" ? "completed" : "invalid");
  });

  it("stops when the Owner opens the Home at the same moment", async () => {
    const [accepted, seen] = await Promise.all([
      accept(),
      asUser(owner, `select state from public.home_ownership_recovery_status('${homeId}');`, 0.5),
    ]);
    // The Owner's read and the handover lock the same case: either the handover committed first
    // (the Owner's read then finds no open case) or the Owner was seen first and it stops.
    expect([
      ["completed", undefined],
      ["owner_returned", "owner_returned"],
    ]).toContainEqual([accepted[0], seen[0]]);
    const current = await owners();
    expect(current).toEqual([accepted[0] === "completed" ? sam : owner]);
  });

  it("never completes after an ordinary transfer moved ownership at the same moment", async () => {
    const [transferId] = await asUser(
      owner,
      `select transfer_id from public.start_ownership_transfer('${homeId}',
         '${await membershipId(alex)}', gen_random_uuid());`,
    );
    const [accepted, transferred] = await Promise.all([
      accept(),
      asUser(
        alex,
        `select public.respond_to_ownership_transfer('${homeId}', '${String(transferId)}', 'accept');`,
        0.5,
      ),
    ]);
    const outcomes = [accepted[0], transferred[0]];
    // A completed recovery ends the pending transfer (answered as no longer valid, or as already
    // decided once it is marked invalid); an accepted transfer ends the recovery.
    expect([
      ["completed", "no_longer_valid"],
      ["completed", "already_decided"],
      ["no_longer_valid", "accepted"],
    ]).toContainEqual(outcomes);
    const current = await owners();
    expect(current).toEqual([outcomes[0] === "completed" ? sam : alex]);
  });

  it("lets an objection or the handover win, never both", async () => {
    const [accepted, objected] = await Promise.all([
      accept(),
      asUser(
        alex,
        `select public.object_to_ownership_recovery('${homeId}', 'I talked to the Owner today.');`,
        0.5,
      ),
    ]);
    const outcomes = [accepted[0], objected[0]];
    expect([
      ["completed", "nothing_open"],
      ["not_ready", "objected"],
    ]).toContainEqual(outcomes);
    expect(await caseStatus()).toBe(outcomes[0] === "completed" ? "completed" : "paused");
    expect(await owners()).toHaveLength(1);
  });
});
