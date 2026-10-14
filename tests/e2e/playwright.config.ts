import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${String(port)}`;

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
  ],
  webServer: {
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
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
    },
  },
});
