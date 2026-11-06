import { fontFamily } from "@madeora/design-tokens";
import { Body } from "@react-email/body";
import { Button } from "@react-email/button";
import { Container } from "@react-email/container";
import { Head } from "@react-email/head";
import { Heading } from "@react-email/heading";
import { Html } from "@react-email/html";
import { Preview } from "@react-email/preview";
import { Text } from "@react-email/text";

import { accent, colours, formatExpiry } from "./home-invitation.tsx";
import { fill, type EmailLocale } from "./messages.ts";

/**
 * Account security emails to an address other than the sign-in address (S37): the link that
 * verifies a new backup address, and the account recovery messages sent to the backup address.
 * Notices to the sign-in address go through the notification email. These name no account
 * details, no Home and no code; a link is single-use and short-lived.
 */
export type SecurityEmailKind =
  "backup_verify" | "recovery_link" | "recovery_started" | "recovery_ready";

export interface SecurityEmailProps {
  readonly kind: SecurityEmailKind;
  readonly locale: EmailLocale;
  /** The link to open, or null for `recovery_started` (which has none). */
  readonly url: string | null;
  /** When the link stops working, or null. */
  readonly expiresAt: Date | null;
}

interface KindMessages {
  readonly subject: string;
  readonly heading: string;
  readonly body: string;
  readonly button: string;
  readonly ignore: string;
}

export const securityEmailMessages = {
  en: {
    expires: "This link works once and expires on {date}.",
    linkFallback: "If the button doesn't work, copy this link into your browser:",
    backup_verify: {
      subject: "Confirm your Madeora backup email address",
      heading: "Confirm your backup email address",
      body: "This address was added as the backup email address of a Madeora account. It is only used to get back into the account if its owner loses access to their sign-in email. Open the link while signed in to that account to confirm.",
      button: "Confirm backup address",
      ignore:
        "If you didn't add this address, ignore this email: nothing changes unless the link is opened.",
    },
    recovery_link: {
      subject: "Recover your Madeora account",
      heading: "Recover your Madeora account",
      body: "Someone asked to recover the Madeora account that uses this address as its backup email. To continue, open the link and enter one of the account's recovery codes. A waiting period follows, and the account's sign-in address is told.",
      button: "Continue recovery",
      ignore:
        "If this wasn't you, ignore this email. Nothing happens without the link and a recovery code.",
    },
    recovery_started: {
      subject: "Your Madeora account recovery has started",
      heading: "Account recovery has started",
      body: "The account that uses this address as its backup email will be recovered after a 72-hour waiting period. The account's sign-in address and the app have been told. When the wait is over, we'll send another link here to finish.",
      button: "",
      ignore:
        "If this wasn't you, sign in to the account and stop the recovery under Settings › Security, then change your password.",
    },
    recovery_ready: {
      subject: "Finish recovering your Madeora account",
      heading: "Finish recovering your account",
      body: "The waiting period is over. Open the link to make this address the account's sign-in address. Every session ends, and you then set a new password through the reset email.",
      button: "Finish recovery",
      ignore:
        "If you didn't ask for this, ignore this email; the account owner can still stop the recovery from Settings › Security.",
    },
  },
  nl: {
    expires: "Deze link werkt één keer en verloopt op {date}.",
    linkFallback: "Werkt de knop niet? Kopieer deze link naar je browser:",
    backup_verify: {
      subject: "Bevestig je reserve-e-mailadres voor Madeora",
      heading: "Bevestig je reserve-e-mailadres",
      body: "Dit adres is toegevoegd als reserve-e-mailadres van een Madeora-account. Het wordt alleen gebruikt om weer in het account te komen als de eigenaar geen toegang meer heeft tot het aanmeldadres. Open de link terwijl je bent aangemeld bij dat account om te bevestigen.",
      button: "Reserveadres bevestigen",
      ignore:
        "Heb je dit adres niet toegevoegd? Negeer deze e-mail dan: er verandert niets zolang de link niet wordt geopend.",
    },
    recovery_link: {
      subject: "Herstel je Madeora-account",
      heading: "Herstel je Madeora-account",
      body: "Iemand heeft gevraagd het Madeora-account te herstellen dat dit adres als reserve-e-mailadres gebruikt. Open de link en vul een van de herstelcodes van het account in om verder te gaan. Daarna volgt een wachttijd en krijgt het aanmeldadres van het account bericht.",
      button: "Herstel voortzetten",
      ignore:
        "Was jij dit niet? Negeer deze e-mail dan. Zonder de link en een herstelcode gebeurt er niets.",
    },
    recovery_started: {
      subject: "Het herstel van je Madeora-account is gestart",
      heading: "Accountherstel is gestart",
      body: "Het account dat dit adres als reserve-e-mailadres gebruikt, wordt hersteld na een wachttijd van 72 uur. Het aanmeldadres van het account en de app hebben bericht gekregen. Als de wachttijd voorbij is, sturen we hier een nieuwe link om het af te ronden.",
      button: "",
      ignore:
        "Was jij dit niet? Meld je aan bij het account, stop het herstel onder Instellingen › Beveiliging en wijzig je wachtwoord.",
    },
    recovery_ready: {
      subject: "Rond het herstel van je Madeora-account af",
      heading: "Rond het herstel van je account af",
      body: "De wachttijd is voorbij. Open de link om dit adres het aanmeldadres van het account te maken. Alle sessies worden beëindigd, en daarna stel je via de herstel-e-mail een nieuw wachtwoord in.",
      button: "Herstel afronden",
      ignore:
        "Heb je hier niet om gevraagd? Negeer deze e-mail; de eigenaar van het account kan het herstel nog stoppen via Instellingen › Beveiliging.",
    },
  },
} as const satisfies Record<
  EmailLocale,
  { readonly expires: string; readonly linkFallback: string } & Record<
    SecurityEmailKind,
    KindMessages
  >
>;

export function securityEmailSubject(props: SecurityEmailProps): string {
  return securityEmailMessages[props.locale][props.kind].subject;
}

export function SecurityEmail(props: SecurityEmailProps) {
  const all = securityEmailMessages[props.locale];
  const t = all[props.kind];
  const text = { color: colours.fg, fontSize: "15px", lineHeight: "24px", margin: "0 0 16px" };
  const muted = { ...text, color: colours.fgMuted, fontSize: "13px", lineHeight: "20px" };

  return (
    <Html lang={props.locale} dir="ltr">
      <Head />
      <Preview>{t.heading}</Preview>
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
            {t.heading}
          </Heading>
          <Text style={text}>{t.body}</Text>
          {props.url && t.button ? (
            <>
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
              {props.expiresAt ? (
                <Text style={text}>
                  {fill(all.expires, {
                    date: formatExpiry(props.expiresAt, props.locale, "UTC"),
                  })}
                </Text>
              ) : null}
              <Text style={muted}>
                {all.linkFallback}
                <br />
                <span style={{ color: accent.accentFg, wordBreak: "break-all" }}>{props.url}</span>
              </Text>
            </>
          ) : null}
          <Text style={{ ...muted, margin: 0 }}>{t.ignore}</Text>
        </Container>
      </Body>
    </Html>
  );
}
