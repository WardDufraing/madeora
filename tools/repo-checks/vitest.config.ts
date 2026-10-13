import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The spec-guard CLI tests create real temporary Git repositories.
    testTimeout: 20_000,
  },
});
