import { z } from "zod";

import { defineJob } from "../definition.ts";

/**
 * The sample job (S13): proves the outbox → dispatcher → task → executor path end to end without
 * touching any data. It only logs its label. Nothing in the app enqueues it; an operator can, from
 * the SQL Editor, to check a fresh environment (docs/background-jobs.md).
 */
export const samplePing = defineJob({
  name: "sample-ping",
  version: 1,
  payload: z.strictObject({
    /** A short, non-personal label to find the run in the logs. */
    label: z.string().regex(/^[a-z0-9-]{1,40}$/),
  }),
  retry: { maxAttempts: 3 },
  leaseSeconds: 60,
  handle(data, { logger, attempt }) {
    logger.info("jobs.sample_ping.ran", { label: data.label, attempt });
    return Promise.resolve();
  },
});
