import "server-only";

import { getVerifiedIdentity } from "@/auth/identity";
import { getHomeContext } from "@/homes/server";
import { homeIdSchema } from "@/homes/schema";

import type { OraToolContext } from "./types";

export type OraToolContextResult =
  | { readonly status: "ok"; readonly context: OraToolContext }
  | { readonly status: "unauthenticated" }
  /** Not a member now, never was, or the Home does not exist: deliberately indistinguishable. */
  | { readonly status: "forbidden" }
  | { readonly status: "unavailable" };

/**
 * Who is asking and where, resolved from the database on every call with the person's own session:
 * the identity is confirmed with Supabase Auth and, for a Home, the membership and the Owner's
 * grants are read fresh, so a revocation applies at once. Nothing the browser sends (the Home id
 * included) is trusted beyond naming the Home to look up.
 */
export async function resolveOraToolContext(
  homeId: string | null | undefined,
): Promise<OraToolContextResult> {
  const identity = await getVerifiedIdentity();
  if (!identity) return { status: "unauthenticated" };
  if (homeId === null || homeId === undefined) return { status: "ok", context: { home: null } };

  const parsed = homeIdSchema.safeParse(homeId);
  if (!parsed.success) return { status: "forbidden" };
  const result = await getHomeContext(parsed.data);
  if (result.status === "not-found") return { status: "forbidden" };
  if (result.status === "unavailable") return { status: "unavailable" };
  return {
    status: "ok",
    context: { home: { id: result.context.home.id, membership: result.context.membership } },
  };
}
