import { defineConfig } from "vitest/config";

// Unit tests of the runner itself. They need no database, so they run in `pnpm test`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
