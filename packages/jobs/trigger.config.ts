// Trigger.dev project configuration (S13, ADR 0017). Read by the Trigger.dev CLI only, run from
// this folder at the same version as @trigger.dev/sdk (the CLI is not a dependency of the repo):
//   pnpm dlx trigger.dev@4.6.4 dev                   (local, Dev environment)
//   pnpm dlx trigger.dev@4.6.4 deploy --env prod     (owner, production project)
//   TRIGGER_PROJECT_REF=<preview ref> pnpm dlx trigger.dev@4.6.4 deploy
//                                                    (owner, preview project; docs/trigger-setup.md)
// The project ref is not a secret. Unset or blank TRIGGER_PROJECT_REF keeps the production
// project, including on the remote build, which does not see the deploy shell. A non-blank
// value selects another project; the CLI passes that resolved ref into the image build.
import { defineConfig } from "@trigger.dev/sdk";

import { resolveTriggerProjectRef } from "./src/trigger-project-ref.ts";

const project = resolveTriggerProjectRef(process.env.TRIGGER_PROJECT_REF);

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
