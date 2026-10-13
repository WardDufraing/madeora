// Runs every rls/**/*.test.sql file against the migrated and seeded test database, each in its
// own rolled-back transaction. Later steps add their RLS tests as new .test.sql files here.
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { runSql, sqlFile } from "../src/run-sql.ts";

const files = globSync("rls/**/*.test.sql", { cwd: new URL("..", import.meta.url) }).sort();

describe("SQL RLS tests", () => {
  it("finds at least one test file", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s", (file) => {
    expect(runSql([sqlFile(file)])).toEqual({ ok: true });
  });
});
