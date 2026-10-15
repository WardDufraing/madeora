import "server-only";

import {
  homePermissions,
  isDelegableCapability,
  isHomeRole,
  type DelegableCapability,
  type HomeMembershipFacts,
  type HomePermissionProjection,
} from "@madeora/domain/permissions";
import { cookies } from "next/headers";
import { cache } from "react";

import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";

import { CONTEXT_COOKIE, parseRememberedContext, type RememberedContext } from "./context-cookie";
import { homeIdSchema } from "./schema";
import type { HomeSummary, MyHome } from "./types";

// A membership with its Home. RLS returns only the signed-in person's own memberships, and only
// Homes they belong to; `!inner` drops a membership whose Home is not visible.
const MEMBERSHIP_WITH_HOME = "role, home:homes!inner(id, name, timezone)";

interface MembershipRow {
  readonly role: string;
  readonly home: { readonly id: string; readonly name: string; readonly timezone: string } | null;
}

function toMyHome(row: MembershipRow): MyHome | null {
  if (!row.home || !isHomeRole(row.role)) return null;
  return { id: row.home.id, name: row.home.name, timeZone: row.home.timezone, role: row.role };
}

export type MyHomes =
  | { readonly status: "ok"; readonly homes: readonly MyHome[] }
  /** The memberships could not be read (database unreachable). */
  | { readonly status: "unavailable" };

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/**
 * The Homes the signed-in person belongs to now, sorted by name, read with their own session so
 * RLS applies. Cached for this request only (React `cache`).
 */
export const listMyHomes = cache(async (): Promise<MyHomes> => {
  const identity = await getVerifiedIdentity();
  if (!identity) return { status: "ok", homes: [] };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("home_memberships")
    .select(MEMBERSHIP_WITH_HOME)
    .eq("user_id", identity.userId);
  if (error) {
    // Privacy-safe: the error code only, no account or Home ids.
    console.error(JSON.stringify({ event: "homes.list_failed", code: error.code }));
    return { status: "unavailable" };
  }
  const homes = data
    .map(toMyHome)
    .filter((home): home is MyHome => home !== null)
    .sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
  return { status: "ok", homes };
});

export interface HomeContext {
  readonly home: HomeSummary;
  readonly membership: HomeMembershipFacts;
  /** What this person may do here, for the interface only; every action is checked again. */
  readonly permissions: HomePermissionProjection;
}

export type HomeContextResult =
  | { readonly status: "ok"; readonly context: HomeContext }
  /** Not a member now, never was, or the Home does not exist: deliberately indistinguishable. */
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

/**
 * The signed-in person's current membership of `homeId` with the Home itself, checked against
 * the database on every call (never from a cache or cookie). Cached for this request only.
 */
export const getHomeContext = cache(async (homeId: string): Promise<HomeContextResult> => {
  const parsedId = homeIdSchema.safeParse(homeId);
  if (!parsedId.success) return { status: "not-found" };
  const identity = await getVerifiedIdentity();
  if (!identity) return { status: "not-found" };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("home_memberships")
    .select(MEMBERSHIP_WITH_HOME)
    .eq("home_id", parsedId.data)
    .eq("user_id", identity.userId)
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ event: "homes.read_failed", code: error.code }));
    return { status: "unavailable" };
  }
  const home = data ? toMyHome(data) : null;
  if (!home) return { status: "not-found" };

  // What the Owner granted this person (S12). Only Administrators hold grants; the database drops
  // them on any other role. Read fresh on every request, so a revocation applies at once.
  let grantedCapabilities = new Set<DelegableCapability>();
  if (home.role === "administrator") {
    const grants = await supabase.rpc("home_capabilities", { p_home_id: home.id });
    if (grants.error?.code === "42501") return { status: "not-found" };
    if (grants.error) {
      console.error(
        JSON.stringify({ event: "homes.capabilities_failed", code: grants.error.code }),
      );
      return { status: "unavailable" };
    }
    grantedCapabilities = new Set(
      grants.data
        .filter((row) => row.is_self)
        .map((row) => row.capability)
        .filter(isDelegableCapability),
    );
  }

  const membership: HomeMembershipFacts = { homeId: home.id, role: home.role, grantedCapabilities };
  return {
    status: "ok",
    context: {
      home: { id: home.id, name: home.name, timeZone: home.timeZone },
      membership,
      permissions: homePermissions(membership),
    },
  };
});

/** The context this device used last, for this account (unverified: check the membership). */
export async function getRememberedContext(userId: string): Promise<RememberedContext | null> {
  return parseRememberedContext((await cookies()).get(CONTEXT_COOKIE)?.value, userId);
}
