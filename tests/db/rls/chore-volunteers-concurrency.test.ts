// S21: volunteer requests and proposals under simultaneous requests. Two invitees accepting the
// same request at once give exactly one assignee (first valid acceptance wins); an acceptance racing
// the withdrawal of that invitation applies one of them; two approvals of one proposal publish one
// chore.
//
// Like chore-pool-concurrency.test.ts this needs overlapping psql sessions, so the data is committed.
// It creates one Home for the seeded users Alice (Owner), Bob and Carol (Members) and deletes it and
// everything it produced afterwards; the database is a disposable local test database
// (architecture.md §25).
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const alice = "(select id from auth.users where email = 'alice@madeora.test')";
const carol = "(select id from auth.users where email = 'carol@madeora.test')";
const bob = "(select id from auth.users where email = 'bob@madeora.test')";
const homeName = "Chore Volunteer Race Home";
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
  await psql(`delete from private.job_outbox o
    where o.payload ->> 'homeId' = (${home})::text;
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

/** A one-off chore by Alice due tomorrow, put in Needs assignment review; its occurrence id. */
async function inReview(title: string): Promise<string> {
  const [chore = ""] = await psql(`select gen_random_uuid();`);
  const [outcome] = await as(
    alice,
    `select outcome from public.create_chore('${chore}', ${home}, '${title}',
      jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(${await member(alice)})),
      p_due_date => ${today} + 1);`,
  );
  expect(outcome).toBe("created");
  const [id = ""] = await psql(
    `select id from private.chore_occurrences where chore_id = '${chore}';`,
  );
  // As if its assignee had left: flagged, nobody assigned.
  await psql(`delete from private.chore_occurrence_assignees where occurrence_id = '${id}';
    update private.chore_occurrences set needs_reassignment = true where id = '${id}';`);
  return id;
}

async function invite(occurrence: string, users: string[]): Promise<string> {
  const [request = ""] = await psql(`select gen_random_uuid();`);
  const members = (await Promise.all(users.map((user) => member(user)))).join(", ");
  const [revision = ""] = await psql(
    `select revision from private.chore_occurrences where id = '${occurrence}';`,
  );
  const [sent] = await as(
    alice,
    `select outcome from public.create_chore_volunteer_request('${request}', '${occurrence}', ${revision},
      array[${members}]::uuid[], false);`,
  );
  expect(sent).toBe("sent");
  return request;
}

async function assignees(occurrence: string): Promise<string[]> {
  return psql(`select split_part(u.email, '@', 1) from private.chore_occurrence_assignees a
    join auth.users u on u.id = a.user_id where a.occurrence_id = '${occurrence}' order by 1;`);
}

async function events(occurrence: string, kind: string): Promise<number> {
  const [count = "0"] = await psql(`select count(*) from private.chore_occurrence_events
    where occurrence_id = '${occurrence}' and kind = '${kind}';`);
  return Number(count);
}

beforeAll(async () => {
  await cleanUp();
  await psql(`begin;
    insert into public.homes (name, timezone, created_by, creation_request_id)
      values ('${homeName}', 'Europe/Brussels', ${alice}, gen_random_uuid());
    insert into public.home_memberships (home_id, user_id, role) values
      (${home}, ${alice}, 'owner'), (${home}, ${bob}, 'member'), (${home}, ${carol}, 'member');
    commit;`);
});
afterAll(cleanUp);

describe("two invitees accepting the same volunteer request at once", () => {
  it("gives exactly one assignee, every time", async () => {
    for (let round = 0; round < 5; round += 1) {
      const occurrence = await inReview(`Volunteer ${String(round)}`);
      const request = await invite(occurrence, [bob, carol]);
      const results = await Promise.all(
        [bob, carol].map((user) =>
          as(
            user,
            `select outcome from public.answer_chore_volunteer_invitation('${request}', 'accept');
select pg_sleep(0.3);`,
          ),
        ),
      );
      expect(results.map(([outcome]) => outcome).sort()).toEqual(["accepted", "not_open"]);
      const winner = results[0]?.[0] === "accepted" ? "bob" : "carol";
      expect(await assignees(occurrence)).toEqual([winner]);
      expect(await events(occurrence, "volunteered")).toBe(1);
      const statuses = await psql(`select i.status from private.chore_volunteer_invitations i
        where i.request_id = '${request}' order by 1;`);
      expect(statuses).toEqual(["accepted", "closed"]);
    }
  });
});

describe("an acceptance racing the withdrawal of that invitation", () => {
  it("either assigns the invitee or withdraws them, never both", async () => {
    const occurrence = await inReview("Withdraw race");
    const request = await invite(occurrence, [carol]);
    const [accept, withdraw] = await Promise.all([
      as(
        carol,
        `select outcome from public.answer_chore_volunteer_invitation('${request}', 'accept');
select pg_sleep(0.3);`,
      ),
      as(
        alice,
        `select outcome from public.change_chore_volunteer_request('${request}', 'withdraw',
          array[${await member(carol)}]::uuid[]);
select pg_sleep(0.3);`,
      ),
    ]);
    const [status = ""] = await psql(
      `select status from private.chore_volunteer_invitations where request_id = '${request}';`,
    );
    if (accept[0] === "accepted") {
      expect(withdraw[0]).toBe("not_open");
      expect(status).toBe("accepted");
      expect(await assignees(occurrence)).toEqual(["carol"]);
    } else {
      expect(accept[0]).toBe("not_open");
      expect(withdraw[0]).toBe("withdrawn");
      expect(status).toBe("withdrawn");
      expect(await assignees(occurrence)).toEqual([]);
    }
  });
});

describe("two approvals of the same proposal at once", () => {
  it("publish exactly one chore", async () => {
    const [proposal = ""] = await psql(`select gen_random_uuid();`);
    const [proposed] = await as(
      carol,
      `select outcome from public.propose_chore('${proposal}', ${home}, 'Shed', ${today});`,
    );
    expect(proposed).toBe("proposed");
    const results = await Promise.all(
      [0, 1].map(() =>
        as(
          alice,
          `select outcome from public.review_chore_proposal('${proposal}', 1, 'approve', null, 'Shed',
            ${today}, '[]');
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["approved", "not_open"]);
    const [chores = ""] = await psql(
      `select count(*) from private.chores where id = '${proposal}';`,
    );
    expect(chores).toBe("1");
    const [occurrences = ""] = await psql(
      `select count(*) from private.chore_occurrences where chore_id = '${proposal}';`,
    );
    expect(occurrences).toBe("1");
  });
});
