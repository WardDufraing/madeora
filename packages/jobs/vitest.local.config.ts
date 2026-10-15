import { defineConfig } from "vitest/config";

// Not part of `pnpm test`: runs the due background jobs once, in this process, against the local
// stack (local/run-due-jobs.local.ts). The browser tests start it through tests/e2e/support/jobs.ts.
// Vitest is used only because it can run the TSX email templates, which Node cannot run directly.
export default defineConfig({
  test: { environment: "node", include: ["src/local-run/*.local.ts"], testTimeout: 60_000 },
});
