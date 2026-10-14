// S11: the database's name rule `private.is_visible_name` against the shared test list the app's
// TypeScript rule uses (apps/web/src/names/visible-name-cases.ts), so the two cannot drift apart.
// Each name is normalized as the app stores it, sent as UTF-8 hex so no invisible character is
// ever written into SQL text, and checked in one psql session.
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { acceptedNames, refusedNames } from "../../../apps/web/src/names/visible-name-cases.ts";
import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

function normalize(value: string): string {
  return value.normalize("NFC").trim();
}

function checkAll(names: readonly string[]): boolean[] {
  const values = names
    .map(
      (name, index) =>
        `(${String(index)}, convert_from(decode('${Buffer.from(normalize(name), "utf8").toString("hex")}', 'hex'), 'UTF8'))`,
    )
    .join(",\n");
  const script = `select private.is_visible_name(name, 50) from (values ${values}) as v(i, name) order by i;`;
  const result = spawnSync(
    "psql",
    [
      "--no-psqlrc",
      "-X",
      "-q",
      "-t",
      "-A",
      "-v",
      "ON_ERROR_STOP=1",
      "--dbname",
      resolveTestDatabaseUrl(),
    ],
    { input: script, encoding: "utf8", env: isolatedEnv() },
  );
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line === "t");
}

describe("private.is_visible_name follows the shared name list", () => {
  it("accepts every accepted name", () => {
    const results = checkAll(acceptedNames.map(([, name]) => name));
    const refused = acceptedNames.filter((_, index) => results[index] !== true).map(([l]) => l);
    expect(refused).toEqual([]);
  });

  it("refuses every refused name", () => {
    const results = checkAll(refusedNames.map(([, name]) => name));
    const accepted = refusedNames.filter((_, index) => results[index] !== false).map(([l]) => l);
    expect(accepted).toEqual([]);
  });

  it("counts characters, not bytes, against the limit", () => {
    expect(checkAll(["\u{1F3E0}".repeat(50), "\u{1F3E0}".repeat(51), "a".repeat(51)])).toEqual([
      true,
      false,
      false,
    ]);
  });
});
