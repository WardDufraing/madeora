// S43: simultaneous approvals of one pairing code create one display in one Home, and simultaneous
// registrations of one approval give the display one session (spec "defend against code
// substitution, cross-Home pairing, concurrent claims, replay and stale approvals").
//
// Unlike the .test.sql files, this needs real concurrency: psql sessions whose transactions
// overlap, so the setup is committed. Every row it creates uses fresh random ids and is deleted
// again afterwards; the database is a disposable local test database (architecture.md §25).
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();

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

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function actAs(userId: string): string {
  return `set local role authenticated;
do $$ begin
  perform set_config('request.jwt.claims', '{"sub": "${userId}", "role": "authenticated"}', true);
end $$;`;
}

function asServer(sql: string, holdSeconds = 0): Promise<string[]> {
  return psql(`begin;
set local role service_role;
${sql}
${holdSeconds > 0 ? `select null from pg_sleep(${String(holdSeconds)});` : ""}
commit;`);
}

async function asUser(userId: string, sql: string, holdSeconds = 0): Promise<string[]> {
  return psql(`begin;
${actAs(userId)}
${sql}
${holdSeconds > 0 ? `select null from pg_sleep(${String(holdSeconds)});` : ""}
commit;`);
}

const managers = [randomUUID(), randomUUID()] as const;
const homes: string[] = [];
const run = randomUUID();

beforeAll(async () => {
  const users = managers
    .map(
      (id) => `('00000000-0000-0000-0000-000000000000', '${id}', 'authenticated', 'authenticated',
        'display-concurrency-${id}@madeora.test', now(), now(), now())`,
    )
    .join(",\n");
  await psql(`insert into auth.users
    (instance_id, id, aud, role, email, email_confirmed_at, created_at, updated_at)
    values ${users};`);
  for (const manager of managers) {
    const [home] = await asUser(
      manager,
      `select public.create_home('Displays', 'UTC', gen_random_uuid());`,
    );
    if (!home) throw new Error("no home");
    homes.push(home);
  }
});

afterAll(async () => {
  const list = homes.map((id) => `'${id}'`).join(", ");
  if (homes.length > 0) {
    await psql(`delete from public.homes where id in (${list});
      delete from private.audit_events where home_id in (${list});`);
  }
  await psql(`delete from private.display_pairing_requests where client_key = '${sha(run)}';
    delete from auth.users where id in (${managers.map((id) => `'${id}'`).join(", ")});`);
});

/** A pending request and its id as a manager's check finds it. */
async function newRequest(seed: string): Promise<{ secret: string; code: string; id: string }> {
  const secret = sha(`${run}:secret:${seed}`);
  const code = sha(`${run}:code:${seed}`);
  await asServer(
    `select outcome from public.display_pairing_start('${secret}', '${code}', '${sha(run)}', '');`,
  );
  const [id] = await asUser(
    managers[0],
    `select request_id from public.check_display_pairing_code('${homes[0] ?? ""}', '${code}');`,
  );
  if (!id) throw new Error("no request");
  return { secret, code, id };
}

describe("simultaneous display pairing", () => {
  it("pairs one code into only one Home when two managers approve it at the same moment", async () => {
    const request = await newRequest("cross-home");
    const outcomes = await Promise.all(
      managers.map((manager, index) =>
        asUser(
          manager,
          `select outcome from public.approve_display_pairing('${homes[index] ?? ""}', '${request.id}',
             '${request.code}', 'Tablet');`,
          0.5,
        ),
      ),
    );
    expect(outcomes.map(([outcome]) => outcome).sort()).toEqual(["already_used", "approved"]);
    const [displays] = await psql(
      `select count(*) from private.household_displays
       where home_id in (${homes.map((id) => `'${id}'`).join(", ")});`,
    );
    expect(displays).toBe("1");
  });

  it("registers one session only when the tablet's claim runs twice at once", async () => {
    const request = await newRequest("double-claim");
    const [display] = await asUser(
      managers[0],
      `select display_id from public.approve_display_pairing('${homes[0] ?? ""}', '${request.id}',
         '${request.code}', 'Gang');`,
    );
    const [account] = await psql(
      `select user_id from private.household_displays where id = '${display ?? ""}';`,
    );
    const sessions = [randomUUID(), randomUUID()];
    await psql(
      sessions
        .map(
          (id) => `insert into auth.sessions (id, user_id, created_at, updated_at, aal)
            values ('${id}', '${account ?? ""}', now(), now(), 'aal1');`,
        )
        .join("\n"),
    );
    const outcomes = await Promise.all(
      sessions.map((session) =>
        asServer(`select public.display_pairing_complete('${request.secret}', '${session}');`, 0.5),
      ),
    );
    expect(outcomes.map(([outcome]) => outcome).sort()).toEqual(["invalid", "registered"]);
    const [registered] = await psql(
      `select count(*) from private.display_sessions where display_id = '${display ?? ""}';`,
    );
    expect(registered).toBe("1");
  });
});
