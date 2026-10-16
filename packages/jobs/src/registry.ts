import { createJobRegistry, type AnyJobDefinition } from "./definition.ts";
import { invitationEmail } from "./jobs/invitation-email.ts";
import { notificationEmail } from "./jobs/notification-email.ts";
import { recoveryReady } from "./jobs/recovery-ready.ts";
import { samplePing } from "./jobs/sample-ping.ts";
import { trashEntryPurge } from "./jobs/trash.ts";
import { storageFilePurge, storageObjectDelete, storageUploadExpire } from "./jobs/storage.ts";

/**
 * Every job this code can run. Adding a job: define it in `src/jobs/`, list it here, and add its
 * Trigger.dev task in `src/trigger/tasks.ts` (docs/background-jobs.md, "Adding a job").
 */
export const jobs: readonly AnyJobDefinition[] = [
  samplePing,
  notificationEmail,
  invitationEmail,
  recoveryReady,
  storageUploadExpire,
  storageFilePurge,
  storageObjectDelete,
  trashEntryPurge,
];

export const jobRegistry = createJobRegistry(jobs);
