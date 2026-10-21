// S20: the database's rotation turns answer the same as packages/domain's. Both run the shared
// vectors in packages/domain/src/chores/rotation-vectors.json (the domain test also checks each one
// against a day-by-day count), so who the database assigns and who the interface previews cannot
// drift apart. Read-only: nothing is written.
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import vectors from "../../../packages/domain/src/chores/rotation-vectors.json" with { type: "json" };
import { isolatedEnv, resolveTestDatabaseUrl } from "../src/run-sql.ts";

const databaseUrl = resolveTestDatabaseUrl();

describe("private.chore_turn", () => {
  it("answers every shared vector like packages/domain", () => {
    const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const rows = vectors
      .map((vector, index) => {
        const { frequency, interval, weekdays, startsOn } = vector.pattern;
        const days = weekdays === null ? "null" : `'{${weekdays.join(",")}}'::smallint[]`;
        return `(${String(index)}, private.chore_turn(${literal(frequency)}, ${String(interval)}, ${days}, date ${literal(startsOn)}, date ${literal(vector.rotationFrom)}, date ${literal(vector.date)}))`;
      })
      .join(",\n");
    const result = spawnSync(
      "psql",
      ["--no-psqlrc", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "--dbname", databaseUrl],
      {
        env: isolatedEnv(),
        input: `select i, d from (values ${rows}) v (i, d) order by i;`,
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const answers = result.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => Number(line.split("|")[1]));
    expect(answers).toEqual(vectors.map((vector) => vector.expected));
  });
});
