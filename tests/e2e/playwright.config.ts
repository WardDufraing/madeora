import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${String(port)}`;

// File storage (S15) goes to the local S3 stand-in (tools/s3-stand-in), never a real bucket.
// Synthetic credentials, valid only against the stand-in, which keeps objects in memory.
const s3Port = Number(process.env.PLAYWRIGHT_S3_PORT ?? 54390);
const storageEnv = {
  STORAGE_DRIVER: "s3",
  STORAGE_S3_ENDPOINT: `http://127.0.0.1:${String(s3Port)}`,
  STORAGE_S3_REGION: "auto",
  STORAGE_S3_BUCKET: "madeora-e2e",
  STORAGE_S3_ACCESS_KEY_ID: "E2eSyntheticAccessKey",
  STORAGE_S3_SECRET_ACCESS_KEY: "E2eSyntheticSecretAccessKey0123456789",
};

// Signed-in browser state saved by setup/signed-in.setup.ts (ignored by Git).
const storageState = "playwright/.auth/user.json";

// Smoke tests run against the production build of apps/web (`pnpm test:e2e` builds it first).
// They need a Supabase Auth to sign in with: the local Supabase stack in CI, or
// `pnpm test:e2e:fallback` without Docker (docs/development.md).
export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /setup\/.*\.setup\.ts$/ },
    {
      name: "chromium",
      testMatch: /specs\/.*\.spec\.ts$/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState },
    },
    // Google sign-in (S08) needs the stand-in Google that only `pnpm test:e2e:fallback` runs
    // (tests/e2e/scripts/fake-google.ts); CI runs it in its own job.
    ...(process.env.PLAYWRIGHT_FAKE_GOOGLE === "1"
      ? [
          {
            name: "google",
            testMatch: /google\/.*\.spec\.ts$/,
            use: { ...devices["Desktop Chrome"] },
          },
        ]
      : []),
  ],
  webServer: [
    {
      command: "pnpm --filter @madeora/s3-stand-in start",
      port: s3Port,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { ...storageEnv, NEXT_PUBLIC_APP_URL: baseURL },
    },
    {
      command: `pnpm --filter @madeora/web exec next start --hostname 127.0.0.1 --port ${String(port)}`,
      url: `${baseURL}/sign-in`,
      reuseExistingServer: false,
      timeout: 60_000,
      // Synthetic, non-secret values: tests never use real service configuration. The Supabase
      // values point at the local stack (CI) or the fallback, never a hosted project.
      env: {
        APP_ENV: "test",
        NEXT_PUBLIC_APP_URL: baseURL,
        NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
          process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
        // Invitation emails (S10) go to the same local mail catcher as the auth emails.
        EMAIL_TRANSPORT: "mailpit",
        MAILPIT_URL: process.env.PLAYWRIGHT_MAILPIT_URL ?? "http://127.0.0.1:54324",
        EMAIL_FROM: "Madeora Test <no-reply@madeora.test>",
        ...storageEnv,
        // Only the finalize step uses it (ADR 0019); the local stack's own throwaway key.
        SUPABASE_SERVICE_ROLE_KEY: process.env.E2E_SERVICE_ROLE_KEY ?? "",
      },
    },
  ],
});
