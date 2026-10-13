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

describe("baseline guards", () => {
  it("fail when a table in schema public has no row level security", () => {
    expectFailure(
      ["create table public.unprotected (id int);", baseline],
      "Every table in schema public has row level security enabled",
    );
  });

  it("fail when a view in schema public is not security_invoker", () => {
    expectFailure(
      ["create view public.leaky as select 1 as id;", baseline],
      "Every view in schema public is security_invoker",
    );
  });
});
