// Usage: pnpm test:e2e:fallback   (from the repository root; extra arguments go to Playwright)
//
// The in-container fallback for the browser tests (build-plan decision D4, brief S06): for machines
// where the Supabase stack (Docker) cannot start. It runs the parts of Supabase the web app uses
// today, without Docker:
//
// - a throwaway PostgreSQL cluster (port 54349) with Supabase Auth's own `auth` schema and then
//   Madeora's migrations from supabase/migrations;
// - Supabase Auth (GoTrue) and the Mailpit mail catcher, built from source with Go at the versions
//   the pinned Supabase CLI uses, and cached in ~/.cache/madeora/auth-fallback;
// - PostgREST, the Data API (S08), at the version the pinned Supabase CLI uses: its official
//   static Linux x86-64 release, checked against a pinned SHA-256 and cached there too;
// - a stand-in for Google's sign-in (fake-google.ts, S08), so Google sign-in and linking run
//   through the real Supabase Auth code;
// - a tiny gateway (port 54351) that serves `/auth/v1/*` and `/rest/v1/*` like Supabase's API
//   gateway does, plus the email templates from supabase/templates;
//
// then builds the web app against it and runs the Playwright suite (`pnpm test:e2e`). Everything is
// deleted on exit. It needs Go (to build the two binaries once) and the PostgreSQL 16+ server
// programs (set PG_BIN if `pg_config --bindir` does not find them). Run as root, PostgreSQL runs as
// the user named in MADEORA_PG_USER (default `nobody`), because it refuses to run as root.
//
// CI runs the same tests against the real Supabase CLI stack; that run is the binding check. The
// Google tests (tests/e2e/google) need the stand-in Google, so they run only here, also in CI's
// "E2E Google sign-in" job: `pnpm test:e2e:fallback -- --project=google`.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { arch, homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startFakeGoogle, type FakeGoogle } from "./fake-google.ts";

// The versions `supabase start` uses with the CLI pinned in package.json (supabase 2.118.0).
// GoTrue's v2 tags are not valid Go module versions, so it is fetched by commit (tag v2.197.0).
const GOTRUE_COMMIT = "4eee58f296d9698a1c2c0ae14d7a0b379c7622d3";
const MAILPIT_VERSION = "v1.30.2";
// PostgREST: `postgrest/postgrest:v16.3` in the same CLI. The checksum is of the release archive.
const POSTGREST_VERSION = "v16.3";
const POSTGREST_SHA256 = "4eb414eb948c8800863cc8c9896a17b611b2dccf9ff581f4d57f42ec9ccee40d";

const PG_PORT = 54349;
const GATEWAY_PORT = 54351;
const GOTRUE_PORT = 54352;
const POSTGREST_PORT = 54353;
const FAKE_GOOGLE_PORT = 54356;
const FAKE_GOOGLE_PROXY_PORT = 54357;
const MAILPIT_HTTP_PORT = 54354;
const MAILPIT_SMTP_PORT = 54355;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const templatesDir = join(repoRoot, "supabase/templates");
const migrationsDir = join(repoRoot, "supabase/migrations");
const cacheDir = join(homedir(), ".cache/madeora/auth-fallback");

function fail(message: string): never {
  console.error(`E2E fallback: ${message}`);
  process.exit(2);
}
const log = (message: string): void => {
  console.log(`E2E fallback: ${message}`);
};

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; uid?: number; gid?: number } = {},
): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.error?.message ?? ""}${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

/** Builds GoTrue and Mailpit once with Go (downloaded through the Go module proxy) and caches them. */
function ensureBinaries(): { gotrue: string; migrations: string; mailpit: string } {
  const gotrueDir = join(cacheDir, `gotrue-${GOTRUE_COMMIT.slice(0, 12)}`);
  const mailpitDir = join(cacheDir, `mailpit-${MAILPIT_VERSION}`);
  const gotrue = join(gotrueDir, "gotrue");
  const mailpit = join(mailpitDir, "mailpit");
  const goEnv = { ...process.env, GOFLAGS: "-mod=mod" };

  if (!existsSync(gotrue)) {
    log(
      `building Supabase Auth (GoTrue ${GOTRUE_COMMIT.slice(0, 12)}); this takes a few minutes once`,
    );
    const info = JSON.parse(
      run("go", ["mod", "download", "-json", `github.com/supabase/auth@${GOTRUE_COMMIT}`], {
        cwd: tmpdir(),
        env: goEnv,
      }),
    ) as { Dir: string };
    rmSync(gotrueDir, { recursive: true, force: true });
    mkdirSync(dirname(gotrueDir), { recursive: true });
    run("cp", ["-R", info.Dir, gotrueDir]);
    run("chmod", ["-R", "u+w", gotrueDir]);
    // The module archive leaves out a vendored fork that has its own go.mod; the upstream package
    // it replaces works for these tests.
    const goMod = join(gotrueDir, "go.mod");
    writeFileSync(
      goMod,
      readFileSync(goMod, "utf8").replace(/^replace github\.com\/joho\/godotenv .*$/m, ""),
    );
    run("go", ["get", "github.com/joho/godotenv@v1.5.1"], { cwd: gotrueDir, env: goEnv });
    run("go", ["build", "-o", gotrue, "."], { cwd: gotrueDir, env: goEnv });
  }
  if (!existsSync(mailpit)) {
    log(`building Mailpit ${MAILPIT_VERSION}`);
    const info = JSON.parse(
      run("go", ["mod", "download", "-json", `github.com/axllent/mailpit@${MAILPIT_VERSION}`], {
        cwd: tmpdir(),
        env: goEnv,
      }),
    ) as { Dir: string };
    rmSync(mailpitDir, { recursive: true, force: true });
    run("cp", ["-R", info.Dir, mailpitDir]);
    run("chmod", ["-R", "u+w", mailpitDir]);
    // The web interface is built with npm in Mailpit's own release process; the tests only use the
    // HTTP API, so an empty page stands in for it.
    mkdirSync(join(mailpitDir, "server/ui/dist"), { recursive: true });
    writeFileSync(
      join(mailpitDir, "server/ui/dist/index.html"),
      "<!doctype html><title>Mailpit</title>",
    );
    run("go", ["build", "-o", mailpit, "."], { cwd: mailpitDir, env: goEnv });
  }
  return { gotrue, migrations: join(gotrueDir, "migrations"), mailpit };
}

/** Downloads PostgREST's official static release once, checks its SHA-256 and caches it. */
async function ensurePostgrest(): Promise<string> {
  const dir = join(cacheDir, `postgrest-${POSTGREST_VERSION}`);
  const binary = join(dir, "postgrest");
  if (existsSync(binary)) return binary;
  if (platform() !== "linux" || arch() !== "x64") {
    fail("the PostgREST stand-in is only set up for Linux x86-64. Use the Supabase stack instead.");
  }
  const archiveName = `postgrest-${POSTGREST_VERSION}-linux-static-x86-64.tar.xz`;
  log(`downloading PostgREST ${POSTGREST_VERSION}`);
  const response = await fetch(
    `https://github.com/PostgREST/postgrest/releases/download/${POSTGREST_VERSION}/${archiveName}`,
  );
  if (!response.ok) fail(`PostgREST download failed (HTTP ${String(response.status)})`);
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== POSTGREST_SHA256) fail(`PostgREST archive checksum mismatch (${digest})`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, archiveName), archive);
  run("tar", ["-xJf", archiveName, "postgrest"], { cwd: dir });
  rmSync(join(dir, archiveName));
  return binary;
}

/** An HS256 token for the Data API, as Supabase's gateway makes from a publishable key. */
function signServiceJwt(secret: string, role: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role, iss: "supabase", iat: now, exp: now + 86_400 })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

function pgBin(): string {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  try {
    return execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim();
  } catch {
    return fail("PostgreSQL binaries not found. Install PostgreSQL 16 or newer, or set PG_BIN.");
  }
}

/** PostgreSQL refuses to run as root; as root, run it as another user. */
function pgUser(): { uid: number; gid: number } | undefined {
  if (process.getuid?.() !== 0) return undefined;
  const name = process.env.MADEORA_PG_USER ?? "nobody";
  const uid = Number(run("id", ["-u", name]).trim());
  const gid = Number(run("id", ["-g", name]).trim());
  return { uid, gid };
}

const children: ChildProcess[] = [];
let gateway: Server | undefined;
let fakeGoogle: FakeGoogle | undefined;
const workDir = mkdtempSync(join(tmpdir(), "madeora-e2e-"));
const bin = pgBin();
const pgAs = pgUser();
let pgStarted = false;

function cleanUp(): void {
  for (const child of children) child.kill("SIGTERM");
  gateway?.close();
  fakeGoogle?.close();
  if (pgStarted) {
    spawnSync(join(bin, "pg_ctl"), ["-D", join(workDir, "data"), "-m", "immediate", "-w", "stop"], {
      stdio: "ignore",
      ...pgAs,
    });
  }
  rmSync(workDir, { recursive: true, force: true });
}
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const) {
  process.on(signal, () => {
    cleanUp();
    process.exit(code);
  });
}

async function waitFor(url: string, name: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`${name} did not start (${url})`);
}

function startGateway(anonJwt: string): Promise<Server> {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/templates/")) {
      const name = url.slice("/templates/".length);
      if (!/^[a-z-]+\.html$/.test(name) || !existsSync(join(templatesDir, name))) {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(readFileSync(join(templatesDir, name)));
      return;
    }
    const service =
      url.startsWith("/auth/v1/") || url === "/auth/v1"
        ? "auth"
        : url.startsWith("/rest/v1/")
          ? "rest"
          : null;
    if (service === null) {
      res.writeHead(404).end();
      return;
    }
    const port = service === "auth" ? GOTRUE_PORT : POSTGREST_PORT;
    const headers = { ...req.headers, host: `127.0.0.1:${String(port)}` };
    // Like Supabase's gateway: a request without a user's token (or with only the publishable key
    // as bearer) reaches the Data API as the anon role.
    if (service === "rest" && !/^Bearer ey/.test(req.headers.authorization ?? "")) {
      headers.authorization = `Bearer ${anonJwt}`;
    }
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: req.method,
        path: url.slice(service === "auth" ? "/auth/v1".length : "/rest/v1".length) || "/",
        headers,
      },
      (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(res);
      },
    );
    upstream.on("error", () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  return new Promise((done) =>
    server.listen(GATEWAY_PORT, "127.0.0.1", () => {
      done(server);
    }),
  );
}

let exitCode = 1;
try {
  const binaries = ensureBinaries();
  const postgrest = await ensurePostgrest();

  log("creating a throwaway PostgreSQL cluster");
  mkdirSync(join(workDir, "data"));
  if (pgAs) {
    chownSync(workDir, pgAs.uid, pgAs.gid);
    chownSync(join(workDir, "data"), pgAs.uid, pgAs.gid);
  }
  run(
    join(bin, "initdb"),
    [
      "-D",
      join(workDir, "data"),
      "-U",
      "postgres",
      "--auth=trust",
      "--encoding=UTF8",
      "--locale=C",
    ],
    { ...pgAs },
  );
  run(
    join(bin, "pg_ctl"),
    [
      "-D",
      join(workDir, "data"),
      "-l",
      join(workDir, "postgres.log"),
      "-o",
      `-c listen_addresses=127.0.0.1 -k ${workDir} -p ${String(PG_PORT)}`,
      "-w",
      "start",
    ],
    { ...pgAs },
  );
  pgStarted = true;

  // What Supabase's Postgres image provides for Auth: its API roles, an `auth` schema owned by
  // the role Auth connects as, and the `extensions` schema with pgcrypto (invitation tokens, S10).
  // Auth creates its own tables with its own migrations.
  const authPassword = randomBytes(18).toString("hex");
  const restPassword = randomBytes(18).toString("hex");
  run("psql", [
    "--no-psqlrc",
    "-q",
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    workDir,
    "-p",
    String(PG_PORT),
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-c",
    `
    create role anon nologin noinherit;
    create role authenticated nologin noinherit;
    create role service_role nologin noinherit bypassrls;
    create role supabase_auth_admin login noinherit createrole password '${authPassword}';
    create schema auth authorization supabase_auth_admin;
    grant create on database postgres to supabase_auth_admin;
    alter role supabase_auth_admin set search_path = auth;
    create role authenticator login noinherit password '${restPassword}';
    grant anon, authenticated, service_role to authenticator;
    grant usage on schema public to anon, authenticated, service_role;
    create schema extensions;
    grant usage on schema extensions to anon, authenticated, service_role;
    create extension pgcrypto with schema extensions;`,
  ]);

  const jwtSecret = randomBytes(32).toString("hex");
  fakeGoogle = await startFakeGoogle({
    workDir,
    port: FAKE_GOOGLE_PORT,
    proxyPort: FAKE_GOOGLE_PROXY_PORT,
    redirectUri: `http://127.0.0.1:${String(GATEWAY_PORT)}/auth/v1/callback`,
  });
  const authEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GOTRUE_DB_DRIVER: "postgres",
    DATABASE_URL: `postgres://supabase_auth_admin:${authPassword}@127.0.0.1:${String(PG_PORT)}/postgres`,
    GOTRUE_DB_MIGRATIONS_PATH: binaries.migrations,
    GOTRUE_API_HOST: "127.0.0.1",
    PORT: String(GOTRUE_PORT),
    API_EXTERNAL_URL: `http://127.0.0.1:${String(GATEWAY_PORT)}/auth/v1`,
    // The same settings as supabase/config.toml.
    GOTRUE_SITE_URL: "http://127.0.0.1:3000",
    GOTRUE_URI_ALLOW_LIST:
      "http://127.0.0.1:3000/**,http://localhost:3000/**,http://127.0.0.1:3100/**",
    GOTRUE_JWT_SECRET: jwtSecret,
    GOTRUE_JWT_EXP: "3600",
    GOTRUE_JWT_AUD: "authenticated",
    GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
    GOTRUE_JWT_ADMIN_ROLES: "service_role",
    GOTRUE_DISABLE_SIGNUP: "false",
    GOTRUE_EXTERNAL_EMAIL_ENABLED: "true",
    GOTRUE_MAILER_AUTOCONFIRM: "false",
    // Matches supabase/config.toml ([auth.sms] enable_confirmations = true). Turned on, Auth
    // would answer a sign-up for an existing address with "User already registered".
    GOTRUE_SMS_AUTOCONFIRM: "false",
    GOTRUE_PASSWORD_MIN_LENGTH: "12",
    GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: "true",
    GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL: "10",
    GOTRUE_RATE_LIMIT_EMAIL_SENT: "1000",
    GOTRUE_RATE_LIMIT_TOKEN_REFRESH: "1000",
    GOTRUE_RATE_LIMIT_VERIFY: "1000",
    GOTRUE_RATE_LIMIT_SIGN_IN_SIGN_UPS: "1000",
    GOTRUE_SMTP_MAX_FREQUENCY: "1s",
    GOTRUE_SMTP_HOST: "127.0.0.1",
    GOTRUE_SMTP_PORT: String(MAILPIT_SMTP_PORT),
    GOTRUE_SMTP_ADMIN_EMAIL: "admin@madeora.test",
    GOTRUE_SMTP_SENDER_NAME: "Madeora",
    GOTRUE_MAILER_SUBJECTS_CONFIRMATION: "Confirm your Madeora email address",
    GOTRUE_MAILER_SUBJECTS_RECOVERY: "Reset your Madeora password",
    GOTRUE_MAILER_TEMPLATES_CONFIRMATION: `http://127.0.0.1:${String(GATEWAY_PORT)}/templates/confirmation.html`,
    GOTRUE_MAILER_TEMPLATES_RECOVERY: `http://127.0.0.1:${String(GATEWAY_PORT)}/templates/recovery.html`,
    // supabase-js sends the publishable key in an `apikey` header; Supabase's gateway allows it.
    GOTRUE_CORS_ALLOWED_HEADERS: "apikey",
    GOTRUE_LOG_LEVEL: "warn",
    // S08: security emails when a sign-in method is linked or unlinked (as supabase/config.toml).
    GOTRUE_MAILER_NOTIFICATIONS_IDENTITY_LINKED_ENABLED: "true",
    GOTRUE_MAILER_NOTIFICATIONS_IDENTITY_UNLINKED_ENABLED: "true",
    GOTRUE_MAILER_SUBJECTS_IDENTITY_LINKED_NOTIFICATION:
      "A sign-in method was linked to your Madeora account",
    GOTRUE_MAILER_SUBJECTS_IDENTITY_UNLINKED_NOTIFICATION:
      "A sign-in method was removed from your Madeora account",
    GOTRUE_MAILER_TEMPLATES_IDENTITY_LINKED_NOTIFICATION: `http://127.0.0.1:${String(GATEWAY_PORT)}/templates/identity-linked.html`,
    GOTRUE_MAILER_TEMPLATES_IDENTITY_UNLINKED_NOTIFICATION: `http://127.0.0.1:${String(GATEWAY_PORT)}/templates/identity-unlinked.html`,
    // S08: Google through the stand-in, and manual linking (supabase/config.toml enables it too).
    GOTRUE_SECURITY_MANUAL_LINKING_ENABLED: "true",
    GOTRUE_EXTERNAL_GOOGLE_ENABLED: "true",
    GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID: fakeGoogle.clientId,
    GOTRUE_EXTERNAL_GOOGLE_SECRET: fakeGoogle.clientSecret,
    GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI: `http://127.0.0.1:${String(GATEWAY_PORT)}/auth/v1/callback`,
    HTTPS_PROXY: fakeGoogle.proxyUrl,
    NO_PROXY: "127.0.0.1,localhost",
    SSL_CERT_FILE: fakeGoogle.caFile,
  };

  log("applying Supabase Auth's migrations");
  run(binaries.gotrue, ["migrate"], { cwd: workDir, env: authEnv });

  // Madeora's own migrations, as `supabase start` applies them after Auth's (as postgres).
  for (const file of readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    log(`migration ${file}`);
    run("psql", [
      "--no-psqlrc",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      workDir,
      "-p",
      String(PG_PORT),
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-f",
      join(migrationsDir, file),
    ]);
  }

  gateway = await startGateway(signServiceJwt(jwtSecret, "anon"));
  const spawnLogged = (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    logName: string,
  ): void => {
    const out = join(workDir, logName);
    writeFileSync(out, "");
    const child = spawn(command, args, { cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"] });
    const append = (chunk: Buffer) => {
      writeFileSync(out, chunk, { flag: "a" });
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    children.push(child);
  };
  spawnLogged(
    binaries.mailpit,
    [
      "--smtp",
      `127.0.0.1:${String(MAILPIT_SMTP_PORT)}`,
      "--listen",
      `127.0.0.1:${String(MAILPIT_HTTP_PORT)}`,
      "--smtp-auth-accept-any",
      "--smtp-auth-allow-insecure",
      "--disable-version-check",
    ],
    { PATH: process.env.PATH },
    "mailpit.log",
  );
  spawnLogged(binaries.gotrue, ["serve"], authEnv, "gotrue.log");
  spawnLogged(
    postgrest,
    [],
    {
      PATH: process.env.PATH,
      PGRST_DB_URI: `postgres://authenticator:${restPassword}@127.0.0.1:${String(PG_PORT)}/postgres`,
      PGRST_DB_SCHEMAS: "public",
      PGRST_DB_ANON_ROLE: "anon",
      PGRST_JWT_SECRET: jwtSecret,
      PGRST_SERVER_HOST: "127.0.0.1",
      PGRST_SERVER_PORT: String(POSTGREST_PORT),
      PGRST_DB_CHANNEL_ENABLED: "false",
    },
    "postgrest.log",
  );
  await waitFor(`http://127.0.0.1:${String(MAILPIT_HTTP_PORT)}/api/v1/info`, "Mailpit");
  await waitFor(`http://127.0.0.1:${String(GATEWAY_PORT)}/auth/v1/health`, "Supabase Auth");
  await waitFor(`http://127.0.0.1:${String(POSTGREST_PORT)}/`, "PostgREST");

  const testEnv = {
    APP_ENV: "test",
    NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3100",
    NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${String(GATEWAY_PORT)}`,
    // The gateway does not check it; the real stack's publishable key does the same job in CI.
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_e2e-fallback",
    // For the few test set-ups the app cannot do yet (tests/e2e/support/database.ts).
    E2E_DATABASE_URL: `postgresql://postgres@127.0.0.1:${String(PG_PORT)}/postgres`,
    PLAYWRIGHT_MAILPIT_URL: `http://127.0.0.1:${String(MAILPIT_HTTP_PORT)}`,
    // Turns on the Google browser tests (tests/e2e/google), which need the stand-in Google.
    PLAYWRIGHT_FAKE_GOOGLE: "1",
  };

  if (process.argv.includes("--serve")) {
    // Keeps the services running for manual debugging until Ctrl-C.
    log("serving; use these values, then press Ctrl-C to stop and delete everything:");
    for (const [key, value] of Object.entries(testEnv)) console.log(`${key}=${value}`);
    await new Promise(() => undefined);
  }

  log("running the browser tests (builds the web app first)");
  // Extra arguments go to Playwright, for example a spec file or --grep.
  const playwrightArgs = process.argv
    .slice(2)
    .filter((arg, index) => !(index === 0 && arg === "--") && arg !== "--serve");
  // Asynchronous, because the gateway runs in this process and must keep answering meanwhile.
  const tests = spawn(
    "pnpm",
    ["test:e2e", ...(playwrightArgs.length > 0 ? ["--", ...playwrightArgs] : [])],
    { cwd: repoRoot, stdio: "inherit", env: { ...process.env, ...testEnv } },
  );
  const status = await new Promise<number | null>((done) => {
    tests.on("exit", (code) => {
      done(code);
    });
  });
  exitCode = status ?? 1;
  if (exitCode !== 0) {
    const tail = readFileSync(join(workDir, "gotrue.log"), "utf8")
      .trim()
      .split("\n")
      .slice(-15)
      .join("\n");
    console.error(`E2E fallback: last Supabase Auth log lines:\n${tail}`);
  }
} catch (error) {
  console.error(`E2E fallback: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 2;
} finally {
  cleanUp();
}
process.exit(exitCode);
