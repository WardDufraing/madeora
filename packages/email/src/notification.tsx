import { fontFamily } from "@madeora/design-tokens";
import { Body } from "@react-email/body";
import { Button } from "@react-email/button";
import { Container } from "@react-email/container";
import { Head } from "@react-email/head";
import { Heading } from "@react-email/heading";
import { Html } from "@react-email/html";
import { Preview } from "@react-email/preview";
import { Text } from "@react-email/text";

import { accent, colours, fillNodes, formatExpiry, isolate } from "./home-invitation.tsx";
import { fill, type EmailLocale } from "./messages.ts";
import {
  isOptionalNotificationKind,
  notificationMessages,
  type NotificationEmailKind,
} from "./notification-messages.ts";

export interface NotificationEmailProps {
  readonly kind: NotificationEmailKind;
  readonly locale: EmailLocale;
  /** The Home's name as its members typed it; never translated. Empty for notices without a Home. */
  readonly homeName: string;
  /** Where the button goes: an absolute address in the app. */
  readonly url: string;
  /** A date some kinds mention (the end of an objection period). */
  readonly date: Date | null;
  /** The Home's timezone for that date; UTC when there is none. */
  readonly timeZone: string;
}

function dateText(props: NotificationEmailProps): string {
  return props.date ? formatExpiry(props.date, props.locale, props.timeZone) : "";
}

/** The subject and preview line, plain text with the Home's name isolated. */
export function notificationSubject(props: NotificationEmailProps): {
  readonly subject: string;
  readonly preview: string;
} {
  const text = notificationMessages[props.locale].kinds[props.kind];
  const values = { home: isolate(props.homeName), date: dateText(props) };
  return { subject: fill(text.subject, values), preview: fill(text.preview, values) };
}

/**
 * The email behind a notification (S14). One layout for every kind: a heading, a short paragraph,
 * one button to the page in the app and a footer saying whether the person can switch it off. It
 * names nobody and never contains a secret.
 */
export function NotificationEmail(props: NotificationEmailProps) {
  const messages = notificationMessages[props.locale];
  const text = messages.kinds[props.kind];
  const home = <bdi style={{ fontWeight: 600 }}>{props.homeName}</bdi>;
  const date = <strong>{dateText(props)}</strong>;
  const paragraph = { color: colours.fg, fontSize: "15px", lineHeight: "24px", margin: "0 0 16px" };
  const muted = { ...paragraph, color: colours.fgMuted, fontSize: "13px", lineHeight: "20px" };

  return (
    <Html lang={props.locale} dir="ltr">
      <Head />
      <Preview>{notificationSubject(props).preview}</Preview>
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
            {fillNodes(text.heading, { home, date })}
          </Heading>
          <Text style={paragraph}>{fillNodes(text.body, { home, date })}</Text>
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
            {text.button}
          </Button>
          <Text style={muted}>
            {messages.linkFallback}
            <br />
            <span style={{ color: accent.accentFg, wordBreak: "break-all" }}>{props.url}</span>
          </Text>
          <Text style={{ ...muted, margin: 0 }}>
            {isOptionalNotificationKind(props.kind)
              ? messages.footerOptional
              : messages.footerSecurity}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
