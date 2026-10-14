import type { HomeRole } from "@madeora/domain/permissions";

/** What every member of a Home may see about it. Client-safe. */
export interface HomeSummary {
  readonly id: string;
  readonly name: string;
  /** The Home's scheduling timezone (IANA). */
  readonly timeZone: string;
}

/** A Home the signed-in person currently belongs to, with their role there. */
export interface MyHome extends HomeSummary {
  readonly role: HomeRole;
}
