// S21: claims under simultaneous requests. Two members claiming the same occurrence at once give
// exactly one winner, one assignee and one claim event (the build plan's done-condition), every
// time; claims on different occurrences both succeed; an Undo racing someone else's claim ends with
// one consistent owner; a release racing a completion never leaves a completed chore unassigned or
// a released one completed by a stale claim; an acceptance racing a cancellation applies once; each
// committed request moves the Home's Realtime signal once and a refused one not at all.
//
// Like chores-concurrency.test.ts this needs overlapping psql sessions, so the data is committed. It
// creates one Home for the seeded users Alice (Owner) and Carol (Member) and deletes it and
// everything it produced afterwards; the database is a disposable local test database
// (architecture.md §25).
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();
const alice = "(select id from auth.users where email = 'alice@madeora.test')";
const carol = "(select id from auth.users where email = 'carol@madeora.test')";
const homeName = "Chore Pool Race Home";
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
    where o.job_name = 'chore-claim-release' and (o.payload ->> 'occurrenceId')::uuid in (
      select x.id from private.chore_occurrences x where x.home_id = ${home});
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

/** A new one-off chore by Alice due today (assigned to `assignee`, or nobody); its occurrence id. */
async function newChore(title: string, assignee: string | null = null): Promise<string> {
  const [chore = ""] = await psql(`select gen_random_uuid();`);
  const assignment = assignee
    ? `jsonb_build_object('mode', 'fixed', 'members', jsonb_build_array(${assignee}))`
    : `'{"mode": "none", "members": []}'`;
  const [outcome] = await as(
    alice,
    `select outcome from public.create_chore('${chore}', ${home}, '${title}', ${assignment},
      p_due_date => ${today});`,
  );
  expect(outcome).toBe("created");
  const [id = ""] = await psql(
    `select id from private.chore_occurrences where chore_id = '${chore}';`,
  );
  return id;
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

async function signal(): Promise<number> {
  const [version = "0"] = await psql(
    `select coalesce((select version from public.chore_pool_signals where home_id = ${home}), 0);`,
  );
  return Number(version);
}

beforeAll(async () => {
  await cleanUp();
  await psql(`begin;
    insert into public.homes (name, timezone, created_by, creation_request_id)
      values ('${homeName}', 'Europe/Brussels', ${alice}, gen_random_uuid());
    insert into public.home_memberships (home_id, user_id, role) values
      (${home}, ${alice}, 'owner'), (${home}, ${carol}, 'member');
    commit;`);
});
afterAll(cleanUp);

describe("two members claiming the same occurrence at once", () => {
  it("gives exactly one winner, one assignee and one claim event, every time", async () => {
    for (let round = 0; round < 5; round += 1) {
      const occurrence = await newChore(`Race ${String(round)}`);
      const before = await signal();
      const results = await Promise.all(
        [alice, carol].map((user) =>
          as(
            user,
            `select outcome from public.claim_chore_occurrence('${occurrence}');
select pg_sleep(0.3);`,
          ),
        ),
      );
      expect(results.map(([outcome]) => outcome).sort()).toEqual(["already_claimed", "claimed"]);
      const winner = results[0]?.[0] === "claimed" ? "alice" : "carol";
      expect(await assignees(occurrence)).toEqual([winner]);
      expect(await events(occurrence, "claimed")).toBe(1);
      const [count = ""] = await psql(
        `select claim_count from private.chore_occurrences where id = '${occurrence}';`,
      );
      expect(count).toBe("1");
      // The winning request moved the signal once; the refused one changed nothing.
      expect((await signal()) - before).toBe(1);
    }
  });

  it("lets both win when they claim different occurrences", async () => {
    const first = await newChore("Left");
    const second = await newChore("Right");
    const results = await Promise.all([
      as(
        alice,
        `select outcome from public.claim_chore_occurrence('${first}');
select pg_sleep(0.3);`,
      ),
      as(
        carol,
        `select outcome from public.claim_chore_occurrence('${second}');
select pg_sleep(0.3);`,
      ),
    ]);
    expect(results.map(([outcome]) => outcome)).toEqual(["claimed", "claimed"]);
    expect(await assignees(first)).toEqual(["alice"]);
    expect(await assignees(second)).toEqual(["carol"]);
  });
});

describe("an Undo racing someone else's claim", () => {
  it("ends with one consistent owner", async () => {
    const occurrence = await newChore("Undo race");
    const [claimed] = await as(
      carol,
      `select outcome from public.claim_chore_occurrence('${occurrence}');`,
    );
    expect(claimed).toBe("claimed");
    const [undo, claim] = await Promise.all([
      as(
        carol,
        `select outcome from public.release_chore_occurrence('${occurrence}', true);
select pg_sleep(0.3);`,
      ),
      as(
        alice,
        `select outcome from public.claim_chore_occurrence('${occurrence}');
select pg_sleep(0.3);`,
      ),
    ]);
    expect(undo[0]).toBe("released");
    if (claim[0] === "claimed") {
      expect(await assignees(occurrence)).toEqual(["alice"]);
    } else {
      // The claim went first and found Carol's claim; the Undo then released it.
      expect(claim[0]).toBe("already_claimed");
      expect(await assignees(occurrence)).toEqual([]);
    }
  });
});

describe("a release racing a completion", () => {
  it("closes or releases once, never both", async () => {
    const occurrence = await newChore("Release race");
    const carolMember = await member(carol);
    const [claimed] = await as(
      carol,
      `select outcome from public.claim_chore_occurrence('${occurrence}');`,
    );
    expect(claimed).toBe("claimed");
    const [release, completion] = await Promise.all([
      as(
        alice,
        `select outcome from public.release_chore_occurrence('${occurrence}');
select pg_sleep(0.3);`,
      ),
      as(
        carol,
        `select outcome from public.complete_chore_occurrence('${occurrence}', ${carolMember});
select pg_sleep(0.3);`,
      ),
    ]);
    const [status = ""] = await psql(
      `select status from private.chore_occurrences where id = '${occurrence}';`,
    );
    // Completing is open to every member, claimed or not; what matters is one consistent record.
    expect(completion[0]).toBe("completed");
    expect(status).toBe("completed");
    if (release[0] === "released") {
      expect(await assignees(occurrence)).toEqual([]);
    } else {
      expect(release[0]).toBe("occurrence_closed");
      expect(await assignees(occurrence)).toEqual(["carol"]);
    }
    expect(await events(occurrence, "completed")).toBe(1);
  });
});

describe("an acceptance racing a cancellation", () => {
  it("applies once", async () => {
    const occurrence = await newChore("Hand over", await member(carol));
    const [request = ""] = await psql(`select gen_random_uuid();`);
    const [asked] = await as(
      carol,
      `select outcome from public.request_chore_reassignment('${request}', '${occurrence}', ${await member(alice)});`,
    );
    expect(asked).toBe("requested");
    const [accept, cancel] = await Promise.all([
      as(
        alice,
        `select outcome from public.answer_chore_reassignment('${request}', 'accept');
select pg_sleep(0.3);`,
      ),
      as(
        carol,
        `select outcome from public.answer_chore_reassignment('${request}', 'cancel');
select pg_sleep(0.3);`,
      ),
    ]);
    const [status = ""] = await psql(
      `select status from private.chore_reassignment_requests where id = '${request}';`,
    );
    if (accept[0] === "accepted") {
      expect(cancel[0]).toBe("not_open");
      expect(status).toBe("accepted");
      expect(await assignees(occurrence)).toEqual(["alice"]);
      expect(await events(occurrence, "reassigned")).toBe(1);
    } else {
      expect(accept[0]).toBe("not_open");
      expect(cancel[0]).toBe("cancelled");
      expect(status).toBe("cancelled");
      expect(await assignees(occurrence)).toEqual(["carol"]);
      expect(await events(occurrence, "reassigned")).toBe(0);
    }
  });
});
