/**
 * The words of Madeora's emails, in every interface language (CLAUDE.md internationalization A:
 * Dutch and English first). Kept with the templates so the package stays framework-free; a test
 * checks both languages have the same keys and placeholders. Placeholders are `{name}`; values
 * are inserted as text by React, never as HTML.
 */
export const emailLocales = ["en", "nl"] as const;
export type EmailLocale = (typeof emailLocales)[number];

export function isEmailLocale(value: unknown): value is EmailLocale {
  return typeof value === "string" && (emailLocales as readonly string[]).includes(value);
}

export const invitationMessages = {
  en: {
    subject: "You're invited to join {home} on Madeora",
    preview: "Open the invitation to ask to join {home}.",
    heading: "Join {home} on Madeora",
    intro: "You've been invited to join the Home {home} on Madeora as {role}.",
    howTo:
      "Open the invitation and sign in with this email address ({email}), or create a Madeora account with it. Someone who manages the Home approves your request before you become a member.",
    button: "View the invitation",
    linkFallback: "If the button doesn't work, copy this link into your browser:",
    expires: "This invitation expires on {date}.",
    ignore:
      "If you weren't expecting this invitation, you can ignore this email. Nothing happens unless you accept it.",
    roleMember: "Member",
    roleAdministrator: "Administrator",
  },
  nl: {
    subject: "Je bent uitgenodigd voor {home} op Madeora",
    preview: "Open de uitnodiging om te vragen of je bij {home} kunt aansluiten.",
    heading: "Sluit aan bij {home} op Madeora",
    intro: "Je bent uitgenodigd om op Madeora aan te sluiten bij het Home {home}, als {role}.",
    howTo:
      "Open de uitnodiging en meld je aan met dit e-mailadres ({email}), of maak er een Madeora-account mee aan. Iemand die het Home beheert, keurt je verzoek goed voordat je lid wordt.",
    button: "Uitnodiging bekijken",
    linkFallback: "Werkt de knop niet? Kopieer deze link naar je browser:",
    expires: "Deze uitnodiging verloopt op {date}.",
    ignore:
      "Verwachtte je deze uitnodiging niet? Dan kun je deze e-mail negeren. Er gebeurt niets zolang je niet accepteert.",
    roleMember: "Lid",
    roleAdministrator: "Beheerder",
  },
} as const satisfies Record<EmailLocale, Record<string, string>>;

export type InvitationMessageKey = keyof (typeof invitationMessages)["en"];

/** Fills `{name}` placeholders with plain text. */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}
