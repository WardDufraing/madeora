// Proves that browser code cannot import server-only settings (S03 review L2, architecture.md §20).
//
// Builds two tiny Next.js apps with the real `next build`:
// - test-fixtures/server-env-in-client: a Client Component imports @madeora/config/env/server.
//   The build must fail with the "server-only" error, naming that component.
// - test-fixtures/public-env-in-client: the same app importing only env/public. It must build,
//   so the failure above can only come from the server-only import.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const fixtures = fileURLToPath(new URL("../test-fixtures/", import.meta.url));

function build(fixture: string): { status: number | null; output: string } {
  const dir = `${fixtures}${fixture}`;
  rmSync(`${dir}/.next`, { recursive: true, force: true });
  const result = spawnSync(process.execPath, [nextBin, "build", dir], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      // Synthetic values only; the fixtures never read real configuration.
      APP_ENV: "test",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3100",
    },
  });
  rmSync(`${dir}/.next`, { recursive: true, force: true });
  // Strip colour codes so the checks below see plain text.
  const output = `${result.stdout}${result.stderr}`.replace(ANSI_COLOUR, "");
  return { status: result.status, output };
}

const failures: string[] = [];

const control = build("public-env-in-client");
if (control.status !== 0) {
  failures.push(
    `The control fixture (public env only) should build but failed:\n${control.output}`,
  );
}

const leak = build("server-env-in-client");
const clientTrace =
  /Client Component Browser:[\s\S]*packages\/config\/src\/env\/server\.ts[\s\S]*leaky-client-component\.jsx/;
if (leak.status === 0) {
  failures.push(
    "A Client Component importing @madeora/config/env/server built successfully. It must fail.",
  );
} else if (
  !leak.output.includes("'server-only' cannot be imported from a Client Component module") ||
  !clientTrace.test(leak.output)
) {
  failures.push(
    `The leaking fixture failed, but not with the expected server-only error:\n${leak.output}`,
  );
}

if (failures.length > 0) {
  console.error(failures.join("\n\n"));
  process.exitCode = 1;
} else {
  console.log(
    "Server-env boundary holds: a Client Component importing env/server fails `next build`; env/public builds.",
  );
}
