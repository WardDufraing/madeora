import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${String(port)}`;

// Smoke tests run against the production build of apps/web (`pnpm test:e2e` builds it first).
export default defineConfig({
  testDir: "./specs",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm --filter @madeora/web exec next start --hostname 127.0.0.1 --port ${String(port)}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
    // Synthetic, non-secret values: tests never use real service configuration.
    env: {
      APP_ENV: "test",
      NEXT_PUBLIC_APP_URL: baseURL,
    },
  },
});
