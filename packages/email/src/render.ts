import { render } from "@react-email/render";
import { createElement } from "react";

import { HomeInvitationEmail, isolate, type HomeInvitationEmailProps } from "./home-invitation.tsx";
import { fill, invitationMessages } from "./messages.ts";

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
