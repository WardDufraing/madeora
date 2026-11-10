import { expect, it } from "vitest";

import { parseStorageEnv, storageConfigFromEnv } from "@madeora/storage";

import { createLocalJobRunner } from "../local.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

it("runs the due background jobs against the local stack", async () => {
  // The local S3 stand-in when the browser tests pass it (S39 exports); never a hosted store, as
  // createLocalJobRunner refuses any non-local address.
  const storage = storageConfigFromEnv(parseStorageEnv(process.env));
  const ran = await createLocalJobRunner({
    supabaseUrl: required("LOCAL_JOBS_SUPABASE_URL"),
    serviceRoleKey: required("LOCAL_JOBS_SERVICE_ROLE_KEY"),
    mailpitUrl: required("LOCAL_JOBS_MAILPIT_URL"),
    from: required("LOCAL_JOBS_FROM"),
    appUrl: required("LOCAL_JOBS_APP_URL"),
    ...(storage ? { storage } : {}),
  }).runUntilIdle();
  expect(ran).toBeGreaterThanOrEqual(0);
});
