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
import { fill, recoveryMessages, type EmailLocale } from "./messages.ts";

/** Which recovery email: staff started checking the request, or approved it. */
export type OwnershipRecoveryEmailKind = "review_started" | "approved";

export interface OwnershipRecoveryEmailProps {
  readonly kind: OwnershipRecoveryEmailKind;
  readonly locale: EmailLocale;
  /** The Home's name as its members typed it; never translated. */
  readonly homeName: string;
  /** The Home's dashboard: `{app}/homes/{homeId}`. */
  readonly url: string;
  /** When the objection period ends; required for `approved`. */
  readonly objectionEndsAt: Date | null;
  /** The Home's scheduling timezone, for that date. */
  readonly timeZone: string;
}

function dateOf(props: OwnershipRecoveryEmailProps): string {
  return props.objectionEndsAt
    ? formatExpiry(props.objectionEndsAt, props.locale, props.timeZone)
    : "";
}

/** The subject and preview line, plain text with the Home's name isolated. */
export function ownershipRecoverySubject(props: OwnershipRecoveryEmailProps): {
  readonly subject: string;
  readonly preview: string;
} {
  const t = recoveryMessages[props.locale];
  const values = { home: isolate(props.homeName), date: dateOf(props) };
  return props.kind === "approved"
    ? { subject: fill(t.approvedSubject, values), preview: fill(t.approvedPreview, values) }
    : { subject: fill(t.reviewSubject, values), preview: fill(t.reviewPreview, values) };
}

/**
 * The email to a Home's Owner about a recovery request (spec "Confirmed verified Home ownership
 * recovery": notify the Owner through verified channels). It names nobody, shows no evidence and
 * says how the Owner stops the request.
 */
export function OwnershipRecoveryEmail(props: OwnershipRecoveryEmailProps) {
  const t = recoveryMessages[props.locale];
  const home = <bdi style={{ fontWeight: 600 }}>{props.homeName}</bdi>;
  const date = <strong>{dateOf(props)}</strong>;
  const approved = props.kind === "approved";
  const text = { color: colours.fg, fontSize: "15px", lineHeight: "24px", margin: "0 0 16px" };
  const muted = { ...text, color: colours.fgMuted, fontSize: "13px", lineHeight: "20px" };

  return (
    <Html lang={props.locale} dir="ltr">
      <Head />
      <Preview>{ownershipRecoverySubject(props).preview}</Preview>
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
            {fillNodes(approved ? t.approvedHeading : t.reviewHeading, { home, date })}
          </Heading>
          <Text style={text}>
            {fillNodes(approved ? t.approvedIntro : t.reviewIntro, { home, date })}
          </Text>
          <Text style={text}>{t.stillHaveAccess}</Text>
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
          <Text style={muted}>
            {t.linkFallback}
            <br />
            <span style={{ color: accent.accentFg, wordBreak: "break-all" }}>{props.url}</span>
          </Text>
          <Text style={{ ...muted, margin: 0 }}>{t.notYou}</Text>
        </Container>
      </Body>
    </Html>
  );
}
