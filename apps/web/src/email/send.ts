import "server-only";

import { emailSettings, getServerEnv } from "@madeora/config/env/server";
import {
  createMailpitTransport,
  createResendTransport,
  renderHomeInvitationEmail,
  type EmailTransport,
  type HomeInvitationEmailProps,
} from "@madeora/email";

/** What happened to an email, as recorded on the invitation. */
export type DeliveryOutcome = "sent" | "failed" | "not_configured";

function transport(): EmailTransport | null {
  const settings = emailSettings(getServerEnv());
  switch (settings.transport) {
    case "resend":
      return createResendTransport({ apiKey: settings.apiKey, from: settings.from });
    case "mailpit":
      return createMailpitTransport({ url: settings.url, from: settings.from });
    case "off":
      return null;
  }
}

/** Whether this environment can send email at all (shown on the invitation form). */
export function canSendEmail(): boolean {
  return emailSettings(getServerEnv()).transport !== "off";
}

/**
 * Renders and sends a Home invitation email (server only: the transport holds the API key).
 * Synchronous until background jobs exist (S13); a failure is returned, never thrown, so the
 * caller records it on the invitation and the manager sees it with Resend as the fix. The log
 * line names the outcome only, never the address, the Home or the link.
 */
export async function sendHomeInvitationEmail(
  props: HomeInvitationEmailProps,
  idempotencyKey: string,
): Promise<DeliveryOutcome> {
  const sender = transport();
  if (!sender) return "not_configured";
  try {
    const email = await renderHomeInvitationEmail(props);
    const result = await sender.send({ to: props.recipientEmail, idempotencyKey, ...email });
    if (result.ok) return "sent";
    console.error(
      JSON.stringify({
        event: "email.invitation_failed",
        reason: result.reason,
        status: result.status ?? null,
      }),
    );
    return "failed";
  } catch {
    console.error(JSON.stringify({ event: "email.invitation_failed", reason: "render" }));
    return "failed";
  }
}
