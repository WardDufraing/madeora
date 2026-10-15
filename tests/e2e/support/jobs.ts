import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { e2eEnv } from "./env";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Runs the background jobs that are due, in a separate process (S14). Emails the app queues
 * (invitations, notifications) are sent by Trigger.dev jobs in production; the browser tests have
 * no Trigger.dev, so a test that expects an email calls this first. The process runs the same
 * outbox, dispatcher and job code (`packages/jobs/src/local-run`) under Vitest, which can run the TSX email
 * templates; it delivers only to the local Mailpit and talks only to the local Supabase stack.
 */
export function runJobs(): void {
  const serviceRoleKey = process.env.E2E_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error(
      "E2E_SERVICE_ROLE_KEY is not set. Run the browser tests through CI's steps or pnpm test:e2e:fallback (docs/development.md).",
    );
  }
  const port = process.env.PLAYWRIGHT_PORT ?? "3100";
  const result = spawnSync(
    "pnpm",
    ["--filter", "@madeora/jobs", "exec", "vitest", "run", "--config", "vitest.local.config.ts"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        LOCAL_JOBS_SUPABASE_URL: e2eEnv.supabaseUrl,
        LOCAL_JOBS_SERVICE_ROLE_KEY: serviceRoleKey,
        LOCAL_JOBS_MAILPIT_URL: e2eEnv.mailpitUrl,
        LOCAL_JOBS_FROM: "Madeora Test <no-reply@madeora.test>",
        LOCAL_JOBS_APP_URL: `http://127.0.0.1:${port}`,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`Running the background jobs failed:\n${result.stdout}\n${result.stderr}`);
  }
}
