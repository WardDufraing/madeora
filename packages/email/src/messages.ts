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

/**
 * The emails to a Home's Owner about a verified ownership recovery request (S12b): when Madeora
 * staff start checking it, and when they approve it. They name no one: who asked is visible to the
 * Owner in the app, and the email only has to reach them and say how to stop it.
 */
export const recoveryMessages = {
  en: {
    reviewSubject: "Someone asked to take over ownership of {home} on Madeora",
    reviewPreview: "If you can still sign in, you can stop this request.",
    reviewHeading: "An ownership review is open for {home}",
    reviewIntro:
      "A member of the Home {home} told Madeora that they cannot reach you, its Owner, and asked to become the Owner. Madeora staff have started checking this request.",
    approvedSubject: "Ownership of {home} on Madeora will move unless you act",
    approvedPreview: "Sign in before {date} to keep ownership of {home}.",
    approvedHeading: "Ownership of {home} can move after {date}",
    approvedIntro:
      "Madeora staff approved the request to make another member the Owner of the Home {home}. If nobody objects, that member can accept ownership after {date}.",
    stillHaveAccess:
      "If you can still sign in, open the Home in Madeora and choose \u201cI still have access\u201d. That ends the request. Signing in alone also stops it.",
    button: "Open the Home",
    linkFallback: "If the button doesn't work, copy this link into your browser:",
    notYou:
      "Madeora never moves ownership because of an email, a code or a password. Staff check every request themselves, and the other members can object.",
  },
  nl: {
    reviewSubject: "Iemand vroeg om het eigenaarschap van {home} op Madeora over te nemen",
    reviewPreview: "Kun je nog aanmelden? Dan kun je dit verzoek stoppen.",
    reviewHeading: "Er loopt een eigenaarschapscontrole voor {home}",
    reviewIntro:
      "Een lid van het Home {home} liet Madeora weten dat het jou, de eigenaar, niet kan bereiken, en vroeg om eigenaar te worden. Medewerkers van Madeora zijn begonnen dit verzoek te controleren.",
    approvedSubject: "Het eigenaarschap van {home} op Madeora gaat over, tenzij je iets doet",
    approvedPreview: "Meld je aan voor {date} om eigenaar van {home} te blijven.",
    approvedHeading: "Het eigenaarschap van {home} kan na {date} overgaan",
    approvedIntro:
      "Medewerkers van Madeora keurden het verzoek goed om een ander lid eigenaar te maken van het Home {home}. Als niemand bezwaar maakt, kan dat lid het eigenaarschap na {date} aanvaarden.",
    stillHaveAccess:
      "Kun je nog aanmelden? Open dan het Home in Madeora en kies \u201cIk heb nog toegang\u201d. Daarmee stopt het verzoek. Alleen al aanmelden stopt het ook.",
    button: "Home openen",
    linkFallback: "Werkt de knop niet? Kopieer deze link naar je browser:",
    notYou:
      "Madeora draagt het eigenaarschap nooit over op basis van een e-mail, een code of een wachtwoord. Medewerkers controleren elk verzoek zelf, en de andere leden kunnen bezwaar maken.",
  },
} as const satisfies Record<EmailLocale, Record<string, string>>;

export type InvitationMessageKey = keyof (typeof invitationMessages)["en"];

/** Fills `{name}` placeholders with plain text. */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}
