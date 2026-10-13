// Runs SQL RLS tests against an isolated local test database with `psql`.
//
// Every run is one psql session: the multi-actor helpers (sql/helpers.sql), then the given SQL
// parts, all inside one transaction that is always rolled back. Nothing a test creates or changes
// is kept, so tests cannot affect each other or the database.
//
// Tests only ever touch a database on this machine: a URL that points anywhere else is refused,
// so no hosted Supabase project can be reached by a test run (build-plan S03).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const databaseUrlVariable = "MADEORA_TEST_DATABASE_URL";

/** The database `supabase start` runs on this machine (supabase/config.toml, [db] port). */
export const defaultLocalDatabaseUrl = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const localHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export class TestDatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDatabaseConfigError";
  }
}

/**
 * The test database URL from MADEORA_TEST_DATABASE_URL, or the local Supabase default.
 * Accepts only a database on this machine: a loopback host, or a Unix socket directory.
 * Errors name the variable but never echo its value, which can contain a password.
 */
export function resolveTestDatabaseUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const raw = env[databaseUrlVariable];
  const value = raw === undefined || raw === "" ? defaultLocalDatabaseUrl : raw;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TestDatabaseConfigError(`${databaseUrlVariable} is not a valid URL.`);
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new TestDatabaseConfigError(
      `${databaseUrlVariable} must be a postgresql:// URL for a local test database.`,
    );
  }

  const socketHost = url.searchParams.get("host");
  const isLocalSocket = url.hostname === "" && socketHost?.startsWith("/") === true;
  const isLoopback = localHosts.has(url.hostname) && socketHost === null;
  if (!isLocalSocket && !isLoopback) {
    throw new TestDatabaseConfigError(
      `${databaseUrlVariable} must point to a database on this machine (127.0.0.1, localhost, ::1 ` +
        `or a Unix socket). RLS tests never run against a hosted database.`,
    );
  }
  return value;
}

const testsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Reads a SQL file relative to tests/db. */
export function sqlFile(relativePath: string): string {
  return readFileSync(resolve(testsRoot, relativePath), "utf8");
}

// A test that ends the transaction itself would keep its changes, and psql meta-commands could
// do anything (\! runs shell commands), so neither may appear in test SQL. The patterns match
// transaction statements but not PL/pgSQL block keywords (`begin` without `;`, `end;`, `end if;`).
const forbiddenStatements = [
  /^\s*(?:commit|rollback|abort)\b/im,
  /^\s*(?:begin|start\s+transaction)\s*(?:transaction|work)?\s*;/im,
  /^\s*end\s+(?:transaction|work)\b/im,
  /^\s*\\/m,
];

// Set at the start of the run and checked at the end: if a test still ended the transaction (for
// example with a bare `end;`), the check fails instead of reporting a pass.
const openMarker = "select set_config('madeora.test_transaction', 'open', true);";
const stillOpenCheck = `do $$
begin
  if current_setting('madeora.test_transaction', true) is distinct from 'open' then
    raise exception 'A test ended the runner''s transaction; tests must not commit or roll back.';
  end if;
end
$$;`;

/** Builds the psql script for one run. Exported for tests. */
export function buildScript(parts: readonly string[]): string {
  for (const part of parts) {
    for (const pattern of forbiddenStatements) {
      const match = pattern.exec(part);
      if (match) {
        throw new Error(
          `Test SQL must not control transactions or use psql meta-commands: "${match[0].trim()}". ` +
            "The runner wraps every test in its own transaction and rolls it back.",
        );
      }
    }
  }
  return [
    "\\set ON_ERROR_STOP on",
    "begin;",
    openMarker,
    sqlFile("sql/helpers.sql"),
    ...parts,
    // Back to the owner before the final check, so a test cannot leave a role switch behind.
    "reset role;",
    stillOpenCheck,
    "rollback;",
    "",
  ].join("\n");
}

export type SqlRunResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** The first `ERROR:` line psql printed, or all of stderr when there is none. */
export function firstError(stderr: string): string {
  const line = stderr.split("\n").find((l) => l.includes("ERROR:"));
  return (line ?? stderr).trim();
}

/** Runs the parts in one rolled-back transaction as the database owner, then as each actor the SQL picks. */
export function runSql(
  parts: readonly string[],
  databaseUrl = resolveTestDatabaseUrl(),
): SqlRunResult {
  const result = spawnSync(
    "psql",
    ["--no-psqlrc", "--quiet", "--no-align", "--tuples-only", "--dbname", databaseUrl],
    { input: buildScript(parts), encoding: "utf8", timeout: 60_000 },
  );
  if (result.error) {
    return { ok: false, error: `Could not run psql: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { ok: false, error: firstError(result.stderr) };
  }
  return { ok: true };
}
