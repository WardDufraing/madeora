import "server-only";

import { z } from "zod";

import { failure } from "@/storage/route-helpers";

/** An id from the path, or null (answered as not found, like one that does not exist). */
export function pathId(value: string): string | null {
  const parsed = z.uuid().safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The database owner arguments for an owner choice: the Home's id, or null for the personal library. */
export function homeOf(
  owner: { readonly scope: "personal" } | { readonly scope: "home"; readonly homeId: string },
): string | null {
  return owner.scope === "home" ? owner.homeId : null;
}

export const notFound = () => failure(404, "not-found");
