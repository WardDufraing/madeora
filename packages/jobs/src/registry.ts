import { createJobRegistry, type AnyJobDefinition } from "./definition.ts";
import { samplePing } from "./jobs/sample-ping.ts";

/**
 * Every job this code can run. Adding a job: define it in `src/jobs/`, list it here, and add its
 * Trigger.dev task in `src/trigger/tasks.ts` (docs/background-jobs.md, "Adding a job").
 */
export const jobs: readonly AnyJobDefinition[] = [samplePing];

export const jobRegistry = createJobRegistry(jobs);
