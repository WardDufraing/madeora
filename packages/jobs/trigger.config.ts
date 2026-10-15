// Trigger.dev project configuration (S13, ADR 0017). Read by the Trigger.dev CLI only, run from
// this folder at the same version as @trigger.dev/sdk (the CLI is not a dependency of the repo):
//   pnpm dlx trigger.dev@4.6.4 dev                   (local, Dev environment)
//   pnpm dlx trigger.dev@4.6.4 deploy --env prod     (owner, docs/trigger-setup.md)
// The project ref is not a secret, but it differs per account, so it comes from the environment.
import { defineConfig } from "@trigger.dev/sdk";

const project = process.env.TRIGGER_PROJECT_REF;
if (!project || !/^proj_[a-z0-9]{10,40}$/.test(project)) {
  throw new Error(
    "Set TRIGGER_PROJECT_REF (proj_...) to the Trigger.dev project, see docs/trigger-setup.md",
  );
}

export default defineConfig({
  project,
  dirs: ["./src/trigger"],
  runtime: "node",
  // Default for tasks without their own policy; every Madeora task sets one.
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 30_000,
      factor: 2,
      randomize: true,
    },
  },
  // Keeps a stuck run from spending the free monthly credit (seconds of compute).
  maxDuration: 300,
  // Madeora's structured logs go to stdout; Trigger.dev shows them per run.
  logLevel: "info",
});
