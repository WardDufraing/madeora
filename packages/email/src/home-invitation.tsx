import { defaultAccent, deriveAccent, fontFamily, neutral } from "@madeora/design-tokens";
import { Body } from "@react-email/body";
import { Button } from "@react-email/button";
import { Container } from "@react-email/container";
import { Head } from "@react-email/head";
import { Heading } from "@react-email/heading";
import { Html } from "@react-email/html";
import { Preview } from "@react-email/preview";
import { Text } from "@react-email/text";
import { Fragment, type ReactNode } from "react";

import { fill, invitationMessages, type EmailLocale } from "./messages.ts";

export type InvitationRole = "member" | "administrator";

export interface HomeInvitationEmailProps {
  readonly locale: EmailLocale;
  /** The Home's name as its members typed it; never translated. */
  readonly homeName: string;
  readonly role: InvitationRole;
  /** The invited address (the recipient's own), so they know which account to use. */
  readonly recipientEmail: string;
  /** The invitation page: `{app}/join/{token}`. */
  readonly url: string;
  readonly expiresAt: Date;
  /** The Home's scheduling timezone, for the expiry date. */
  readonly timeZone: string;
}

// Emails cannot use CSS variables or the theme: the light theme's tokens, with the default accent
// (a Home's own accent is not known to an email client and is not shown before joining).
export const colours = neutral.light;
export const accent = deriveAccent(defaultAccent.light, "light");

/** "21 October 2026, 18:00 CEST" in the email's language and the Home's timezone. */
export function formatExpiry(expiresAt: Date, locale: EmailLocale, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    // 24-hour clock: the recipient's own format is not known yet.
    hourCycle: "h23",
    timeZone,
    timeZoneName: "short",
  }).format(expiresAt);
}

/** Fills `{name}` placeholders with React nodes, so names stay text and can be isolated. */
export function fillNodes(
  template: string,
  values: Readonly<Record<string, ReactNode>>,
): ReactNode[] {
  return template.split(/(\{\w+\})/g).map((part, index) => {
    const match = /^\{(\w+)\}$/.exec(part);
    const value = match?.[1] === undefined ? undefined : values[match[1]];
    return <Fragment key={index}>{value ?? part}</Fragment>;
  });
}

/**
 * The email invitation (spec "Confirmed Home invitations", "Confirmed private accounts and
 * invitation-only discovery"): only the Home's name, the proposed role, the expiry and the link.
 * It names no inviter and no other member, and says that a manager approves before access.
 */
export function HomeInvitationEmail(props: HomeInvitationEmailProps) {
  const t = invitationMessages[props.locale];
  const role = props.role === "administrator" ? t.roleAdministrator : t.roleMember;
  // <bdi>: a name written right to left cannot reorder the sentence around it.
  const home = <bdi style={{ fontWeight: 600 }}>{props.homeName}</bdi>;
  const text = { color: colours.fg, fontSize: "15px", lineHeight: "24px", margin: "0 0 16px" };
  const muted = { ...text, color: colours.fgMuted, fontSize: "13px", lineHeight: "20px" };

  return (
    <Html lang={props.locale} dir="ltr">
      <Head />
      <Preview>{fill(t.preview, { home: isolate(props.homeName) })}</Preview>
      <Body style={{ backgroundColor: colours.page, fontFamily: fontFamily.sans, margin: 0 }}>
        <Container
          style={{
            backgroundColor: colours.surface,
            border: `1px solid ${colours.line}`,
            borderRadius: "12px",
            margin: "32px auto",
            maxWidth: "560px",
            padding: "32px",
          }}
        >
          <Heading
            as="h1"
            style={{ color: colours.fg, fontSize: "20px", lineHeight: "28px", margin: "0 0 16px" }}
          >
            {fillNodes(t.heading, { home })}
          </Heading>
          <Text style={text}>{fillNodes(t.intro, { home, role })}</Text>
          <Text style={text}>{fillNodes(t.howTo, { email: props.recipientEmail })}</Text>
          <Button
            href={props.url}
            style={{
              backgroundColor: accent.accent,
              borderRadius: "8px",
              color: accent.onAccent,
              display: "inline-block",
              fontSize: "15px",
              fontWeight: 600,
              margin: "8px 0 24px",
              padding: "12px 20px",
              textDecoration: "none",
            }}
          >
            {t.button}
          </Button>
          <Text style={text}>
            {fill(t.expires, {
              date: formatExpiry(props.expiresAt, props.locale, props.timeZone),
            })}
          </Text>
          <Text style={muted}>
            {t.linkFallback}
            <br />
            <span style={{ color: accent.accentFg, wordBreak: "break-all" }}>{props.url}</span>
          </Text>
          <Text style={{ ...muted, margin: 0 }}>{t.ignore}</Text>
        </Container>
      </Body>
    </Html>
  );
}

/** FSI … PDI around a name in plain text (subject, preview, text version). */
export function isolate(name: string): string {
  return `⁨${name}⁩`;
}
