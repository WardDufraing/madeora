import { homeIdSchema } from "./schema";

/**
 * The context this device used last: Personal or one Home (spec "Confirmed explicit multi-Home
 * switching": remember the last valid active Home as a convenience). Written by the browser when a
 * Home or the personal dashboard is shown, read by the server when `/` is opened.
 *
 * It is a convenience only, never an access decision: the server checks the membership every
 * time and ignores a Home the person no longer belongs to. The value carries the account id, so a
 * cookie left by another account on a shared device is ignored too.
 */
export const CONTEXT_COOKIE = "md-context";

export type RememberedContext =
  { readonly kind: "personal" } | { readonly kind: "home"; readonly homeId: string };

/** The cookie value for `userId` (account ids and Home ids are UUIDs, so `.` separates them). */
export function formatRememberedContext(userId: string, context: RememberedContext): string {
  return `${userId}.${context.kind === "home" ? context.homeId : "personal"}`;
}

/** The remembered context for `userId`, or `null` when missing, malformed or another account's. */
export function parseRememberedContext(
  value: string | undefined,
  userId: string,
): RememberedContext | null {
  if (value === undefined) return null;
  const separator = value.indexOf(".");
  if (separator < 0 || value.slice(0, separator) !== userId) return null;
  const rest = value.slice(separator + 1);
  if (rest === "personal") return { kind: "personal" };
  return homeIdSchema.safeParse(rest).success ? { kind: "home", homeId: rest.toLowerCase() } : null;
}
