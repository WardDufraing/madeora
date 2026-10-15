import { render } from "@react-email/render";
import { createElement } from "react";

import { HomeInvitationEmail, isolate, type HomeInvitationEmailProps } from "./home-invitation.tsx";
import { fill, invitationMessages } from "./messages.ts";
import {
  NotificationEmail,
  notificationSubject,
  type NotificationEmailProps,
} from "./notification.tsx";
import {
  OwnershipRecoveryEmail,
  ownershipRecoverySubject,
  type OwnershipRecoveryEmailProps,
} from "./ownership-recovery.tsx";

/** A rendered email: subject, HTML and the plain-text alternative (CLAUDE.md email strategy A). */
export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** Renders the Home invitation email in its language, as HTML and plain text. */
export async function renderHomeInvitationEmail(
  props: HomeInvitationEmailProps,
): Promise<RenderedEmail> {
  const element = createElement(HomeInvitationEmail, props);
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return {
    subject: fill(invitationMessages[props.locale].subject, { home: isolate(props.homeName) }),
    html,
    text,
  };
}

/** Renders an ownership recovery email to a Home's Owner, as HTML and plain text. */
export async function renderOwnershipRecoveryEmail(
  props: OwnershipRecoveryEmailProps,
): Promise<RenderedEmail> {
  if (props.kind === "approved" && !props.objectionEndsAt) {
    throw new Error("An approved recovery email needs the end of the objection period.");
  }
  const element = createElement(OwnershipRecoveryEmail, props);
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { subject: ownershipRecoverySubject(props).subject, html, text };
}

/** Renders the email behind a notification (S14), as HTML and plain text. */
export async function renderNotificationEmail(
  props: NotificationEmailProps,
): Promise<RenderedEmail> {
  const element = createElement(NotificationEmail, props);
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { subject: notificationSubject(props).subject, html, text };
}
