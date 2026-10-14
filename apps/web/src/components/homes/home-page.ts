import "server-only";

import { redirect } from "next/navigation";

import { getHomeContext, type HomeContext } from "@/homes/server";

/** Where a Home page sends someone who cannot open it: Personal, with one neutral notice. */
export const HOME_UNAVAILABLE_PATH = "/?notice=home-unavailable";

/**
 * The Home for a Home page, or a redirect to the personal dashboard with the same neutral notice
 * whether the Home does not exist, the id is malformed, or the person is not (or no longer) a
 * member (spec: explain the change without revealing revoked Home information). `null` when the
 * database could not be read, so the page can say so instead of pretending the Home is gone.
 */
export async function loadHomeForPage(homeId: string): Promise<HomeContext | null> {
  const found = await getHomeContext(homeId);
  if (found.status === "not-found") redirect(HOME_UNAVAILABLE_PATH);
  return found.status === "ok" ? found.context : null;
}

/** The Home's name for headings and titles, isolated (FSI … PDI) so right-to-left names cannot
 * reorder the text around them. */
export function isolatedName(name: string): string {
  return `\u{2068}${name}\u{2069}`;
}
