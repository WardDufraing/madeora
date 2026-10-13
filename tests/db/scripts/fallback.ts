// Usage: pnpm test:db:fallback   (from the repository root)
//
// The in-container fallback from build-plan decision D4, for machines where the Supabase stack
// (Docker) cannot start. It creates a throwaway PostgreSQL cluster in a temporary folder, listening
// only on 127.0.0.1 (port 54339) and a socket in that folder, applies the Supabase shim, every
// migration in order and the seed, runs the database tests and the database types check against it,
// then stops and deletes it.
//
// It needs the PostgreSQL server binaries (initdb, pg_ctl) and psql. Set PG_BIN to their folder if
// `pg_config --bindir` does not find them. initdb refuses to run as root.
//
// CI runs the same tests against the real Supabase CLI stack; that run is the binding check.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(testsRoot, "../..");
const supabaseDir = join(repoRoot, "supabase");
const port = "54339";

function fail(message: string): never {
  console.error(`DB fallback: ${message}`);
  process.exit(2);
}

// Thrown inside the main block, so the cluster is still stopped and deleted (process.exit would
// skip the `finally`).
class StepError extends Error {}

function pgBin(): string {
  const fromEnv = process.env.PG_BIN;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    return execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim();
  } catch {
    return fail("PostgreSQL binaries not found. Install PostgreSQL 16 or newer, or set PG_BIN.");
  }
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new StepError(`${command} failed:\n${result.error?.message ?? result.stderr}`);
  }
}

if (process.getuid?.() === 0) {
  fail("initdb cannot run as root. Run this command as a normal user.");
}

const bin = pgBin();
const dataDir = mkdtempSync(join(tmpdir(), "madeora-db-"));
let started = false;

function cleanUp(): void {
  if (started) {
    spawnSync(join(bin, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "-w", "stop"], {
      stdio: "ignore",
    });
  }
  rmSync(dataDir, { recursive: true, force: true });
}
process.on("SIGINT", () => {
  cleanUp();
  process.exit(130);
});

let exitCode = 1;
try {
  console.log("DB fallback: creating a throwaway PostgreSQL cluster");
  run(join(bin, "initdb"), [
    "-D",
    dataDir,
    "-U",
    "supabase_admin",
    "--auth=trust",
    "--encoding=UTF8",
    "--locale=C",
  ]);
  // -l sends the server's output to a log file; otherwise the server would keep this script's
  // output pipes open and pg_ctl would never return.
  run(join(bin, "pg_ctl"), [
    "-D",
    dataDir,
    "-l",
    join(dataDir, "server.log"),
    "-o",
    `-c listen_addresses=127.0.0.1 -k ${dataDir} -p ${port}`,
    "-w",
    "start",
  ]);
  started = true;

  // Loopback TCP rather than the socket: `supabase gen types` ignores the port for socket URLs.
  const url = (user: string): string => `postgresql://${user}@127.0.0.1:${port}/postgres`;
  const psql = (user: string, file: string): void => {
    run("psql", ["--no-psqlrc", "--quiet", "-v", "ON_ERROR_STOP=1", "-d", url(user), "-f", file]);
  };

  console.log("DB fallback: applying the Supabase shim");
  psql("supabase_admin", join(testsRoot, "shim/supabase-shim.sql"));

  const migrations = readdirSync(join(supabaseDir, "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrations) {
    console.log(`DB fallback: migration ${name}`);
    psql("postgres", join(supabaseDir, "migrations", name));
  }
  console.log("DB fallback: seed.sql");
  psql("postgres", join(supabaseDir, "seed.sql"));

  console.log("DB fallback: running the database tests");
  const tests = spawnSync("pnpm", ["exec", "vitest", "run", "--config", "vitest.db.config.ts"], {
    cwd: testsRoot,
    stdio: "inherit",
    env: { ...process.env, MADEORA_TEST_DATABASE_URL: url("postgres") },
  });
  exitCode = tests.status ?? 1;

  if (exitCode === 0) {
    console.log("DB fallback: checking the generated database types");
    const types = spawnSync("node", [join(testsRoot, "scripts/gen-types.ts"), "--check"], {
      stdio: "inherit",
      env: { ...process.env, MADEORA_TEST_DATABASE_URL: url("postgres") },
    });
    exitCode = types.status ?? 1;
  }
} catch (error) {
  if (!(error instanceof StepError)) throw error;
  console.error(`DB fallback: ${error.message}`);
  exitCode = 2;
} finally {
  cleanUp();
}
process.exit(exitCode);
