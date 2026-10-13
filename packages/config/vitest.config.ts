import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Vitest runs server modules outside Next.js, where "server-only" would always throw.
    alias: { "server-only": fileURLToPath(new URL("./testing/empty-module.ts", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
