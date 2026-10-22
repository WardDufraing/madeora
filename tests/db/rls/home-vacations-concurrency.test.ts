// S22: Home vacations under simultaneous requests. Two chore managers deciding the same affected
// occurrence at once record exactly one decision; two acceptances of one invitation accept it once;
// an acceptance racing the withdrawal of that invitation applies exactly one of them.
//
// Like chore-volunteers-concurrency.test.ts this needs overlapping psql sessions, so the data is
// committed. It creates one Home for the seeded users Alice (Owner), Bob (Administrator with manageHomeChores) and Carol
// (Member) and deletes it and everything it produced afterwards; the database is a disposable local
// test database (architecture.md §25).
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const alice = "(select id from auth.users where email = 'alice@madeora.test')";
const bob = "(select id from auth.users where email = 'bob@madeora.test')";
const carol = "(select id from auth.users where email = 'carol@madeora.test')";
const homeName = "Home Vacation Race Home";
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
  return id;
}

function stay(memberId: string, from: number, to: number): string {
  return `jsonb_build_object('memberId', '${memberId}', 'startsOn', ${today} + ${String(from)},
    'endsOn', ${today} + ${String(to)})`;
}

/** Carol's vacation on days 2 and 3 in which she suggests Bob; Bob's pending participation id. */
async function invitation(): Promise<string> {
  const [vacation = ""] = await psql(`select gen_random_uuid();`);
  const [outcome] = await as(
    carol,
    `select outcome from public.create_home_vacation('${vacation}', ${home}, null,
      jsonb_build_array(${stay(await member(carol), 2, 3)}, ${stay(await member(bob), 2, 3)}));`,
  );
  expect(outcome).toBe("created");
  const [participant = ""] = await psql(`select id from private.home_vacation_participants
    where vacation_id = '${vacation}' and user_id = ${bob} and status = 'pending';`);
  return participant;
}

beforeAll(async () => {
  await cleanUp();
  await psql(`begin;
    insert into public.homes (name, timezone, created_by, creation_request_id)
      values ('${homeName}', 'Europe/Brussels', ${alice}, gen_random_uuid());
    insert into public.home_memberships (home_id, user_id, role) values
      (${home}, ${alice}, 'owner'), (${home}, ${bob}, 'administrator'), (${home}, ${carol}, 'member');
    insert into private.home_admin_capabilities (home_id, user_id, capability)
      values (${home}, ${bob}, 'manageHomeChores');
    commit;`);
});
afterAll(cleanUp);

describe("two chore managers deciding the same affected occurrence at once", () => {
  it("record exactly one decision, every time", async () => {
    for (let round = 0; round < 3; round += 1) {
      const [chore = "", vacation = ""] = await psql(
        `select gen_random_uuid(); select gen_random_uuid();`,
      );
      const [created] = await as(
        alice,
        `select outcome from public.create_chore('${chore}', ${home}, 'Windows ${String(round)}',
          jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array('${await member(carol)}')),
          p_due_date => ${today} + 2);`,
      );
      expect(created).toBe("created");
      const [away] = await as(
        alice,
        `select outcome from public.create_home_vacation('${vacation}', ${home}, null,
          jsonb_build_array(${stay(await member(carol), 2, 3)}));`,
      );
      expect(away).toBe("created");
      const [occurrence = "", revision = ""] =
        (
          await psql(`select id || ' ' || revision from private.chore_occurrences
          where chore_id = '${chore}';`)
        )[0]?.split(" ") ?? [];
      const results = await Promise.all(
        [
          [alice, "keep"],
          [bob, "skip"],
        ].map(([user = "", decision = ""]) =>
          as(
            user,
            `select outcome from public.decide_chore_vacation_item('vacation', '${vacation}',
              '${occurrence}', ${revision}, '${decision}');
select pg_sleep(0.3);`,
          ),
        ),
      );
      expect(results.map(([outcome]) => outcome).sort()).toEqual(["already_decided", "decided"]);
      const [decisions = ""] = await psql(`select count(*) from private.chore_vacation_decisions
        where occurrence_id = '${occurrence}';`);
      expect(decisions).toBe("1");
      const [status = ""] = await psql(
        `select status from private.chore_occurrences where id = '${occurrence}';`,
      );
      expect(status).toBe(results[0]?.[0] === "decided" ? "open" : "skipped");
    }
  });
});

describe("two acceptances of the same invitation at once", () => {
  it("accept it once", async () => {
    const participant = await invitation();
    const results = await Promise.all(
      [0, 1].map(() =>
        as(
          bob,
          `select outcome from public.change_vacation_participation('${participant}', 1, 'accept', false);
select pg_sleep(0.3);`,
        ),
      ),
    );
    expect(results.map(([outcome]) => outcome).sort()).toEqual(["conflict", "saved"]);
    const [events = ""] = await psql(`select count(*) from private.home_vacation_events e
      join private.home_vacation_participants p on p.vacation_id = e.vacation_id
      where p.id = '${participant}' and e.kind = 'accepted' and e.subject_id = ${bob};`);
    expect(events).toBe("1");
  });
});

describe("an acceptance racing the withdrawal of that invitation", () => {
  it("applies exactly one of them", async () => {
    const participant = await invitation();
    const [accept, withdraw] = await Promise.all([
      as(
        bob,
        `select outcome from public.change_vacation_participation('${participant}', 1, 'accept', false);
select pg_sleep(0.3);`,
      ),
      as(
        carol,
        `select outcome from public.change_vacation_participation('${participant}', 1, 'cancel_invitation', false);
select pg_sleep(0.3);`,
      ),
    ]);
    const [status = ""] = await psql(
      `select status from private.home_vacation_participants where id = '${participant}';`,
    );
    if (accept[0] === "saved") {
      expect(withdraw[0]).toBe("conflict");
      expect(status).toBe("accepted");
    } else {
      expect(accept[0]).toBe("conflict");
      expect(withdraw[0]).toBe("saved");
      expect(status).toBe("withdrawn");
    }
  });
});
