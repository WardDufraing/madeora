import type { EmailLocale } from "./messages.ts";

/**
 * The emails about notifications (S14), by event. `{home}` is the Home's name as its members typed
 * it, `{date}` a date and time in the Home's timezone. The wording names nobody and shows no
 * evidence: who asked, who objected and why stay inside the app, visible to those entitled to it.
 */
export const notificationKinds = [
  "recovery.claimant_review_started",
  "recovery.claimant_approved",
  "recovery.claimant_paused",
  "recovery.claimant_resumed",
  "recovery.claimant_rejected",
  "recovery.claimant_ended_owner_access",
  "recovery.claimant_invalid",
  "recovery.claimant_completed",
  "recovery.claimant_ready",
  "recovery.former_owner_completed",
  "recovery.former_owner_completed_removed",
  "join_request.received",
  "join_request.decided.approved",
  "join_request.decided.declined",
] as const;

export type NotificationEmailKind = (typeof notificationKinds)[number];

export interface NotificationEmailText {
  readonly subject: string;
  readonly preview: string;
  readonly heading: string;
  readonly body: string;
  readonly button: string;
}

type Catalogue = Record<NotificationEmailKind, NotificationEmailText>;

const en: Catalogue = {
  "recovery.claimant_review_started": {
    subject: "Madeora started reviewing your ownership request for {home}",
    preview: "Nothing changes until the review is finished.",
    heading: "Your ownership request is being reviewed",
    body: "Madeora staff have started checking your request to become the Owner of {home}. Nothing changes in the Home until the review is finished and a waiting period has passed. We will email you at each step.",
    button: "See where it stands",
  },
  "recovery.claimant_approved": {
    subject: "Your ownership request for {home} was approved: the waiting period has started",
    preview: "You can accept after {date}.",
    heading: "The waiting period has started",
    body: "Madeora approved your request to become the Owner of {home}. The current Owner and the other adult members can still object until {date}. If nobody objects and the Owner does not show they still have access, you can accept ownership after that.",
    button: "See where it stands",
  },
  "recovery.claimant_paused": {
    subject: "Your ownership request for {home} is paused",
    preview: "Nothing has changed in the Home.",
    heading: "Your request is paused",
    body: "Madeora paused your request about {home} while it looks into it further. Nothing has changed in the Home. We will tell you if the review continues or ends.",
    button: "See where it stands",
  },
  "recovery.claimant_resumed": {
    subject: "Your ownership request for {home} continues",
    preview: "The review is going on again.",
    heading: "Your request continues",
    body: "Madeora resumed the review of your request about {home}. We will email you when something changes.",
    button: "See where it stands",
  },
  "recovery.claimant_rejected": {
    subject: "Your ownership request for {home} was not approved",
    preview: "Nothing has changed in the Home.",
    heading: "Your request was not approved",
    body: "Madeora did not approve your request to become the Owner of {home}. Nothing has changed in the Home.",
    button: "Open the Home",
  },
  "recovery.claimant_ended_owner_access": {
    subject: "Your ownership request for {home} has ended",
    preview: "The Owner showed they still have access.",
    heading: "Your request has ended",
    body: "The Owner of {home} showed that they still have access to their account, so your request has ended. Nothing has changed in the Home.",
    button: "Open the Home",
  },
  "recovery.claimant_invalid": {
    subject: "Your ownership request for {home} can no longer continue",
    preview: "Something changed in the Home.",
    heading: "Your request can no longer continue",
    body: "Something changed in {home}, for example who its Owner is or your own membership, so your request cannot continue. Nothing has changed in the Home's ownership because of it.",
    button: "Open the Home",
  },
  "recovery.claimant_completed": {
    subject: "You are now the Owner of {home}",
    preview: "You manage its members, roles and settings.",
    heading: "You are now the Owner of {home}",
    body: "You accepted ownership, so you are now the Owner of {home}. You manage its members, roles and settings from here.",
    button: "Open the Home",
  },
  "recovery.claimant_ready": {
    subject: "You can now accept ownership of {home}",
    preview: "The waiting period has ended.",
    heading: "You can now accept ownership",
    body: "The waiting period for your request about {home} has ended and nobody has stopped it. Open Madeora and accept to become the Owner. Madeora checks everything again when you accept.",
    button: "Accept ownership",
  },
  "recovery.former_owner_completed": {
    subject: "Ownership of {home} moved to another member",
    preview: "You are still a member of the Home.",
    heading: "Ownership of {home} moved",
    body: "After a Madeora review, another member became the Owner of {home}. You are still a member of the Home. If you think this is wrong, you can send an appeal from your recoveries page.",
    button: "Open your recoveries",
  },
  "recovery.former_owner_completed_removed": {
    subject: "Ownership of a Home you owned moved to another member",
    preview: "You are no longer a member of that Home.",
    heading: "Ownership of a Home you owned moved",
    body: "After a Madeora review, another member became the Owner of a Home you owned, and you are no longer a member of it. If you think this is wrong, you can send an appeal from your recoveries page.",
    button: "Open your recoveries",
  },
  "join_request.received": {
    subject: "New request to join {home}",
    preview: "Open the invitations page to answer it.",
    heading: "Someone asked to join {home}",
    body: "Someone used an invitation or join code to ask to join {home}. Open the invitations page to approve or decline.",
    button: "Open the invitations",
  },
  "join_request.decided.approved": {
    subject: "Your request to join a Home was approved",
    preview: "Open Madeora to see your new Home.",
    heading: "Your request was approved",
    body: "A manager approved your request to join a Home. Open Madeora to see it.",
    button: "Open Madeora",
  },
  "join_request.decided.declined": {
    subject: "Your request to join a Home was declined",
    preview: "A manager answered your request.",
    heading: "Your request was declined",
    body: "A manager declined your request to join a Home. You can ask the person who invited you for another invitation.",
    button: "Open Madeora",
  },
};

const nl: Catalogue = {
  "recovery.claimant_review_started": {
    subject: "Madeora begon je eigenaarschapsverzoek voor {home} te controleren",
    preview: "Er verandert niets tot de controle klaar is.",
    heading: "Je eigenaarschapsverzoek wordt gecontroleerd",
    body: "Medewerkers van Madeora zijn begonnen je verzoek te controleren om eigenaar van {home} te worden. In het Home verandert niets tot de controle klaar is en een wachtperiode voorbij is. We mailen je bij elke stap.",
    button: "Bekijk de stand van zaken",
  },
  "recovery.claimant_approved": {
    subject: "Je eigenaarschapsverzoek voor {home} is goedgekeurd: de wachtperiode is begonnen",
    preview: "Je kunt aanvaarden na {date}.",
    heading: "De wachtperiode is begonnen",
    body: "Madeora keurde je verzoek goed om eigenaar van {home} te worden. De huidige eigenaar en de andere volwassen leden kunnen tot {date} nog bezwaar maken. Maakt niemand bezwaar en toont de eigenaar niet dat die nog toegang heeft, dan kun je daarna het eigenaarschap aanvaarden.",
    button: "Bekijk de stand van zaken",
  },
  "recovery.claimant_paused": {
    subject: "Je eigenaarschapsverzoek voor {home} is gepauzeerd",
    preview: "In het Home is niets veranderd.",
    heading: "Je verzoek is gepauzeerd",
    body: "Madeora pauzeerde je verzoek over {home} om het verder te onderzoeken. In het Home is niets veranderd. We laten het weten als de controle verdergaat of eindigt.",
    button: "Bekijk de stand van zaken",
  },
  "recovery.claimant_resumed": {
    subject: "Je eigenaarschapsverzoek voor {home} gaat verder",
    preview: "De controle loopt weer.",
    heading: "Je verzoek gaat verder",
    body: "Madeora zette de controle van je verzoek over {home} weer voort. We mailen je zodra er iets verandert.",
    button: "Bekijk de stand van zaken",
  },
  "recovery.claimant_rejected": {
    subject: "Je eigenaarschapsverzoek voor {home} is niet goedgekeurd",
    preview: "In het Home is niets veranderd.",
    heading: "Je verzoek is niet goedgekeurd",
    body: "Madeora keurde je verzoek om eigenaar van {home} te worden niet goed. In het Home is niets veranderd.",
    button: "Home openen",
  },
  "recovery.claimant_ended_owner_access": {
    subject: "Je eigenaarschapsverzoek voor {home} is beëindigd",
    preview: "De eigenaar toonde dat die nog toegang heeft.",
    heading: "Je verzoek is beëindigd",
    body: "De eigenaar van {home} toonde dat die nog toegang heeft tot het account, dus je verzoek is beëindigd. In het Home is niets veranderd.",
    button: "Home openen",
  },
  "recovery.claimant_invalid": {
    subject: "Je eigenaarschapsverzoek voor {home} kan niet meer doorgaan",
    preview: "Er is iets veranderd in het Home.",
    heading: "Je verzoek kan niet meer doorgaan",
    body: "Er is iets veranderd in {home}, bijvoorbeeld wie de eigenaar is of je eigen lidmaatschap, waardoor je verzoek niet kan doorgaan. Hierdoor is het eigenaarschap van het Home niet veranderd.",
    button: "Home openen",
  },
  "recovery.claimant_completed": {
    subject: "Je bent nu eigenaar van {home}",
    preview: "Jij beheert de leden, rollen en instellingen.",
    heading: "Je bent nu eigenaar van {home}",
    body: "Je aanvaardde het eigenaarschap, dus je bent nu eigenaar van {home}. Vanaf nu beheer jij de leden, rollen en instellingen.",
    button: "Home openen",
  },
  "recovery.claimant_ready": {
    subject: "Je kunt nu het eigenaarschap van {home} aanvaarden",
    preview: "De wachtperiode is voorbij.",
    heading: "Je kunt het eigenaarschap nu aanvaarden",
    body: "De wachtperiode voor je verzoek over {home} is voorbij en niemand heeft het gestopt. Open Madeora en aanvaard om eigenaar te worden. Madeora controleert alles opnieuw wanneer je aanvaardt.",
    button: "Eigenaarschap aanvaarden",
  },
  "recovery.former_owner_completed": {
    subject: "Het eigenaarschap van {home} ging over naar een ander lid",
    preview: "Je bent nog steeds lid van het Home.",
    heading: "Het eigenaarschap van {home} is overgegaan",
    body: "Na een controle door Madeora werd een ander lid eigenaar van {home}. Je bent nog steeds lid van het Home. Denk je dat dit niet klopt, dan kun je via je pagina met herstelverzoeken beroep aantekenen.",
    button: "Je herstelverzoeken openen",
  },
  "recovery.former_owner_completed_removed": {
    subject: "Het eigenaarschap van een Home dat je bezat ging over naar een ander lid",
    preview: "Je bent geen lid meer van dat Home.",
    heading: "Het eigenaarschap van een Home dat je bezat is overgegaan",
    body: "Na een controle door Madeora werd een ander lid eigenaar van een Home dat jij bezat, en ben je er geen lid meer van. Denk je dat dit niet klopt, dan kun je via je pagina met herstelverzoeken beroep aantekenen.",
    button: "Je herstelverzoeken openen",
  },
  "join_request.received": {
    subject: "Nieuw verzoek om aan te sluiten bij {home}",
    preview: "Open de uitnodigingenpagina om te antwoorden.",
    heading: "Iemand vroeg om aan te sluiten bij {home}",
    body: "Iemand gebruikte een uitnodiging of toetredingscode om te vragen of die bij {home} kan aansluiten. Open de uitnodigingenpagina om goed te keuren of af te wijzen.",
    button: "Uitnodigingen openen",
  },
  "join_request.decided.approved": {
    subject: "Je verzoek om bij een Home aan te sluiten is goedgekeurd",
    preview: "Open Madeora om je nieuwe Home te zien.",
    heading: "Je verzoek is goedgekeurd",
    body: "Een beheerder keurde je verzoek goed om bij een Home aan te sluiten. Open Madeora om het te zien.",
    button: "Madeora openen",
  },
  "join_request.decided.declined": {
    subject: "Je verzoek om bij een Home aan te sluiten is afgewezen",
    preview: "Een beheerder beantwoordde je verzoek.",
    heading: "Je verzoek is afgewezen",
    body: "Een beheerder wees je verzoek af om bij een Home aan te sluiten. Je kunt de persoon die je uitnodigde vragen om een nieuwe uitnodiging.",
    button: "Madeora openen",
  },
};

export const notificationMessages = {
  en: {
    kinds: en,
    ...{
      linkFallback: "If the button doesn't work, copy this link into your browser:",
      footerSecurity:
        "This is a security message about a Home you belong to or your account. It cannot be switched off.",
      footerOptional:
        "You can choose which notifications you get by email in Settings, under Notifications.",
    },
  },
  nl: {
    kinds: nl,
    ...{
      linkFallback: "Werkt de knop niet? Kopieer deze link naar je browser:",
      footerSecurity:
        "Dit is een veiligheidsbericht over een Home waarvan je lid bent of over je account. Je kunt het niet uitschakelen.",
      footerOptional:
        "Je kiest zelf welke meldingen je per e-mail krijgt in Instellingen, onder Meldingen.",
    },
  },
} as const satisfies Record<
  EmailLocale,
  {
    kinds: Catalogue;
    linkFallback: string;
    footerSecurity: string;
    footerOptional: string;
  }
>;

/** Optional kinds follow the person's choices; the others are security messages. */
export function isOptionalNotificationKind(kind: NotificationEmailKind): boolean {
  return kind.startsWith("join_request.");
}
