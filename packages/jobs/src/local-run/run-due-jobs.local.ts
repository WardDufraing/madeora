import { expect, it } from "vitest";

import { createLocalJobRunner } from "../local.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

it("runs the due background jobs against the local stack", async () => {
  const ran = await createLocalJobRunner({
    supabaseUrl: required("LOCAL_JOBS_SUPABASE_URL"),
    serviceRoleKey: required("LOCAL_JOBS_SERVICE_ROLE_KEY"),
    mailpitUrl: required("LOCAL_JOBS_MAILPIT_URL"),
    from: required("LOCAL_JOBS_FROM"),
    appUrl: required("LOCAL_JOBS_APP_URL"),
  }).runUntilIdle();
  expect(ran).toBeGreaterThanOrEqual(0);
});
