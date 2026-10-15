import "server-only";

import { emailEnabled, getServerEnv } from "@madeora/config/env/server";

/**
 * Whether this environment sends the app's own email (invitations, notifications). The web app
 * never sends email itself: the database queues each email in the outbox and a Trigger.dev job
 * sends it with the provider's key (S14, ADR 0018). This flag only decides whether the invitation
 * form offers "by email", so it must match the jobs' own `EMAIL_TRANSPORT`.
 */
export function canSendEmail(): boolean {
  return emailEnabled(getServerEnv());
}
