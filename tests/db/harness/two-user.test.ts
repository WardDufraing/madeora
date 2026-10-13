// Self-test of the RLS harness (build-plan S03 "Done when"): the two-user check passes with its
// owner-only policy, and the very same check fails when the policy is dropped, disabled or widened.
// If any of the "fails" cases passed, the harness could not detect a broken policy.
import { describe, expect, it } from "vitest";

import { runSql, sqlFile } from "../src/run-sql.ts";

const fixture = sqlFile("harness/notes-fixture.sql");
const twoUserCheck = sqlFile("harness/two-user.sql");
const baseline = sqlFile("rls/baseline.test.sql");

function expectFailure(parts: readonly string[], message: string): void {
  const result = runSql(parts);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain(message);
}

describe("two-user RLS check", () => {
  it("passes with the owner-only policy", () => {
    expect(runSql([fixture, twoUserCheck])).toEqual({ ok: true });
  });

  it("fails when the policy is dropped", () => {
    expectFailure(
      [fixture, "drop policy notes_owner_only on harness.notes;", twoUserCheck],
      "Alice sees exactly one note (expected 1 rows, got 0)",
    );
  });

  it("fails when row level security is switched off", () => {
    expectFailure(
      [fixture, "alter table harness.notes disable row level security;", twoUserCheck],
      "Alice sees exactly one note (expected 1 rows, got 2)",
    );
  });

  it("fails when the policy lets every signed-in user read every note", () => {
    const widened = `
      drop policy notes_owner_only on harness.notes;
      create policy notes_read_all on harness.notes for select to authenticated using (true);
      create policy notes_write_own on harness.notes for insert to authenticated
        with check (owner_id = (select auth.uid()));
    `;
    expectFailure([fixture, widened, twoUserCheck], "Alice sees exactly one note");
  });

  it("fails when the policy accepts a forged owner_id", () => {
    const forgeable = `
      drop policy notes_owner_only on harness.notes;
      create policy notes_read_own on harness.notes for select to authenticated
        using (owner_id = (select auth.uid()));
      create policy notes_insert_any on harness.notes for insert to authenticated with check (true);
    `;
    expectFailure(
      [fixture, forgeable, twoUserCheck],
      "Alice cannot add a note in Bob's name (forged owner_id)",
    );
  });
});

describe("assertion helpers", () => {
  it("assert_denied fails when the statement is refused with a different error", () => {
    expectFailure(
      [
        fixture,
        "select tests.act_as('alice');",
        `select tests.assert_denied(
           $$insert into harness.notes (owner_id, body) values (tests.user_id('bob'), 'forged')$$,
           'refused as a unique violation', '23505');`,
      ],
      "refused as a unique violation (expected error 23505, got 42501",
    );
  });

  it("assert_denied fails when the statement succeeds", () => {
    expectFailure(
      [
        fixture,
        "select tests.act_as('alice');",
        "select tests.assert_denied($$select 1$$, 'refused');",
      ],
      "refused (expected error 42501, but the statement succeeded)",
    );
  });

  it("assert_allowed fails when the statement is refused", () => {
    expectFailure(
      [
        fixture,
        "select tests.act_as_anon();",
        "select tests.assert_allowed($$insert into harness.notes (body) values ('x')$$, 'anon may insert');",
      ],
      "anon may insert (expected success, got 42501",
    );
  });
});

describe("baseline guards", () => {
  it("fail when a table in schema public has no row level security", () => {
    expectFailure(
      ["create table public.unprotected (id int);", baseline],
      "Every table in schema public has row level security enabled",
    );
  });

  it("pass when a new function in schema private gets only the default privileges", () => {
    expect(
      runSql([
        "create function private.helper() returns int language sql as 'select 1';",
        baseline,
      ]),
    ).toEqual({ ok: true });
  });

  it("fail when a function in schema private is executable by PUBLIC", () => {
    expectFailure(
      [
        "create function private.helper() returns int language sql as 'select 1';",
        "grant execute on function private.helper() to public;",
        baseline,
      ],
      "No function in schema private is executable by PUBLIC, anon or authenticated",
    );
  });

  it("fail when a function in schema private is executable by authenticated", () => {
    expectFailure(
      [
        "create function private.helper() returns int language sql as 'select 1';",
        "grant execute on function private.helper() to authenticated;",
        baseline,
      ],
      "No function in schema private is executable by PUBLIC, anon or authenticated",
    );
  });

  it("fail when a view in schema public is not security_invoker", () => {
    expectFailure(
      ["create view public.leaky as select 1 as id;", baseline],
      "Every view in schema public is security_invoker",
    );
  });
});
