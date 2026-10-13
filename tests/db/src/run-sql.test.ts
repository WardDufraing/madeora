import { describe, expect, it } from "vitest";

import {
  TestDatabaseConfigError,
  buildScript,
  databaseUrlVariable,
  defaultLocalDatabaseUrl,
  firstError,
  resolveTestDatabaseUrl,
} from "./run-sql.ts";

describe("resolveTestDatabaseUrl", () => {
  it("defaults to the local Supabase database", () => {
    expect(resolveTestDatabaseUrl({})).toBe(defaultLocalDatabaseUrl);
    expect(resolveTestDatabaseUrl({ [databaseUrlVariable]: "" })).toBe(defaultLocalDatabaseUrl);
  });

  it.each([
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    "postgres://postgres@localhost:5432/postgres",
    "postgresql://postgres@[::1]:5432/postgres",
    "postgresql:///postgres?host=%2Ftmp%2Fmadeora-db-abc&port=54339&user=postgres",
  ])("accepts the local database %s", (url) => {
    expect(resolveTestDatabaseUrl({ [databaseUrlVariable]: url })).toBe(url);
  });

  it.each([
    "postgresql://postgres:secret-password@db.abcdefghijklmnop.supabase.co:5432/postgres",
    "postgresql://postgres:secret-password@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
    "postgresql://postgres:secret-password@10.0.0.5:5432/postgres",
    "postgresql://postgres:secret-password@127.0.0.1.example.com:5432/postgres",
    // A loopback host name with a socket or remote host override in the query string.
    "postgresql://postgres:secret-password@127.0.0.1/postgres?host=db.example.com",
    "postgresql://postgres:secret-password@/postgres?host=db.example.com",
  ])("refuses a database that is not on this machine: %s", (url) => {
    expect(() => resolveTestDatabaseUrl({ [databaseUrlVariable]: url })).toThrow(
      TestDatabaseConfigError,
    );
  });

  it("refuses other protocols and malformed values", () => {
    expect(() =>
      resolveTestDatabaseUrl({ [databaseUrlVariable]: "mysql://root@127.0.0.1/db" }),
    ).toThrow(TestDatabaseConfigError);
    expect(() => resolveTestDatabaseUrl({ [databaseUrlVariable]: "not a url" })).toThrow(
      TestDatabaseConfigError,
    );
  });

  it("names the variable but never echoes its value", () => {
    const url = "postgresql://postgres:secret-password@db.example.supabase.co:5432/postgres";
    try {
      resolveTestDatabaseUrl({ [databaseUrlVariable]: url });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain(databaseUrlVariable);
      expect(String(error)).not.toContain("secret-password");
      expect(String(error)).not.toContain("supabase.co");
    }
  });
});

describe("buildScript", () => {
  it("wraps the helpers and the parts in one transaction that is rolled back", () => {
    const script = buildScript(["select 1;"]);
    const lines = script.trimEnd().split("\n");
    expect(lines[0]).toBe("\\set ON_ERROR_STOP on");
    expect(lines[1]).toBe("begin;");
    expect(script).toContain("create schema tests;");
    expect(script.indexOf("create schema tests;")).toBeLessThan(script.indexOf("select 1;"));
    expect(lines.at(-1)).toBe("rollback;");
    expect(script).toContain("A test ended the runner''s transaction");
  });

  it.each([
    "commit;",
    "COMMIT;",
    "  rollback;",
    "abort;",
    "begin;",
    "BEGIN TRANSACTION;",
    "start transaction;",
    "end transaction;",
    "\\! rm -rf /",
    "\\c other_database",
    "select 1;\ncommit;",
  ])("refuses test SQL that controls the transaction or uses psql commands: %j", (sql) => {
    expect(() => buildScript([sql])).toThrow(/must not control transactions/);
  });

  it("allows PL/pgSQL blocks, whose begin and end are not transaction statements", () => {
    const block = "do $$\nbegin\n  if true then\n    perform 1;\n  end if;\nend\n$$;";
    expect(() => buildScript([block])).not.toThrow();
  });
});

describe("firstError", () => {
  it("returns the first psql ERROR line", () => {
    const stderr =
      "psql:<stdin>:12: ERROR:  RLS assertion failed: Bob sees exactly one note (expected 1 rows, got 2)\n" +
      "CONTEXT:  PL/pgSQL function tests.assert_row_count(text,bigint,text) line 6 at RAISE\n";
    expect(firstError(stderr)).toBe(
      "psql:<stdin>:12: ERROR:  RLS assertion failed: Bob sees exactly one note (expected 1 rows, got 2)",
    );
  });

  it("falls back to all of stderr when psql printed no ERROR line", () => {
    expect(firstError("psql: connection refused\n")).toBe("psql: connection refused");
  });
});
