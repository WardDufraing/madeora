import { defineConfig } from "vitest/config";

// Database tests: they need a migrated and seeded local test database (`pnpm db:start`, or the
// fallback), so they run only in `pnpm test:db`, never in `pnpm test`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["harness/**/*.test.ts", "rls/**/*.test.ts"],
    testTimeout: 60_000,
    // One psql session at a time keeps runs predictable on small CI runners.
    fileParallelism: false,
  },
});
