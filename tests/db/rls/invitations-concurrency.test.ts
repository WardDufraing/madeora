// S10: simultaneous approvals, requests and creations cannot exceed an invitation's cap, create two
// memberships or pass the 25-invitation limit (spec: "acceptance must be atomic so simultaneous
// attempts cannot exceed the cap"; "enforce this limit at invitation creation, including
// simultaneous creation attempts").
//
// Unlike the .test.sql files, this needs real concurrency: two psql sessions whose transactions
// overlap, so the setup is committed. Every row it creates uses fresh random ids and is deleted
// again afterwards; the database is a disposable local test database (architecture.md §25).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

/** SQL that makes the rest of the transaction run as `userId` through the API role. */
function actAs(userId: string): string {
  return `set local role authenticated;
do $$ begin
  perform set_config('request.jwt.claims', '{"sub": "${userId}", "role": "authenticated"}', true);
end $$;`;
}

const owner = randomUUID();
const applicants = [randomUUID(), randomUUID(), randomUUID()] as const;
let homeId = "";

async function asUser(userId: string, sql: string, holdSeconds = 0): Promise<string[]> {
  return psql(`begin;
${actAs(userId)}
${sql}
${holdSeconds > 0 ? `select null from pg_sleep(${String(holdSeconds)});` : ""}
commit;`);
}

async function createLink(cap: number): Promise<string> {
  const [token] = await asUser(
    owner,
    `select token from public.create_home_invitation('${homeId}', 'link', 'member', gen_random_uuid(), null, null,
       '7d', ${String(cap)});`,
  );
  if (!token) throw new Error("no token");
  return token;
}

async function requestJoin(userId: string, token: string): Promise<string> {
  const [requestId] = await asUser(
    userId,
    `select request_id from public.request_to_join_home('${token}');`,
  );
  if (!requestId) throw new Error("no request");
  return requestId;
}

beforeAll(async () => {
  const users = [owner, ...applicants]
    .map(
      (id) => `('00000000-0000-0000-0000-000000000000', '${id}', 'authenticated', 'authenticated',
        'concurrency-${id}@madeora.test', now(), now(), now())`,
    )
    .join(",\n");
  await psql(`insert into auth.users
    (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
    values ${users};`);
  [homeId] = (await asUser(
    owner,
    `select public.create_home('Concurrency', 'UTC', gen_random_uuid());`,
  )) as [string];
});

afterAll(async () => {
  if (homeId) {
    await psql(`delete from public.homes where id = '${homeId}';
      delete from private.audit_events where home_id = '${homeId}';`);
  }
  await psql(
    `delete from auth.users where id in (${[owner, ...applicants].map((id) => `'${id}'`).join(", ")});`,
  );
});

async function memberCount(): Promise<number> {
  const [count] = await psql(
    `select count(*) from public.home_memberships where home_id = '${homeId}' and role = 'member';`,
  );
  return Number(count);
}

describe("simultaneous invitation use", () => {
  it("lets only one of two simultaneous approvals use a single-use link", async () => {
    const token = await createLink(1);
    const first = await requestJoin(applicants[0], token);
    const second = await requestJoin(applicants[1], token);

    // Each approval holds its locks for a moment before committing, so the two overlap.
    const outcomes = await Promise.all(
      [first, second].map((requestId) =>
        asUser(
          owner,
          `select public.decide_join_request('${homeId}', '${requestId}', 'approve');`,
          0.5,
        ),
      ),
    );
    expect(outcomes.map(([outcome]) => outcome).sort()).toEqual(["approved", "no_longer_valid"]);
    expect(await memberCount()).toBe(1);
    const [admissions] = await psql(
      `select admissions from private.home_invitations where token = '${token}';`,
    );
    expect(admissions).toBe("1");
  });

  it("decides the same request only once when two managers approve it at the same moment", async () => {
    const token = await createLink(5);
    const requestId = await requestJoin(applicants[2], token);
    const before = await memberCount();

    const outcomes = await Promise.all(
      [0, 1].map(() =>
        asUser(
          owner,
          `select public.decide_join_request('${homeId}', '${requestId}', 'approve');`,
          0.5,
        ),
      ),
    );
    expect(outcomes.map(([outcome]) => outcome).sort()).toEqual(["already_decided", "approved"]);
    expect(await memberCount()).toBe(before + 1);
  });

  it("never passes 25 active invitations with simultaneous creations", async () => {
    const [active] = await asUser(
      owner,
      `select count(*) from public.list_home_invitations('${homeId}') where state = 'active';`,
    );
    for (let made = Number(active); made < 24; made += 1) await createLink(1);

    const outcomes = await Promise.all(
      [0, 1, 2].map(() =>
        asUser(
          owner,
          `select outcome from public.create_home_invitation('${homeId}', 'join_code', 'member', gen_random_uuid(),
             null, null, '7d', null);`,
          0.3,
        ),
      ),
    );
    expect(outcomes.map(([outcome]) => outcome).sort()).toEqual([
      "created",
      "limit_reached",
      "limit_reached",
    ]);
    const [after] = await asUser(
      owner,
      `select count(*) from public.list_home_invitations('${homeId}') where state = 'active';`,
    );
    expect(after).toBe("25");
  });
});
