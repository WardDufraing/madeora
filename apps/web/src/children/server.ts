import "server-only";

import {
  childAgeBands,
  childPresets,
  decideChildAction,
  isChildCapability,
  isHomeRole,
  type ChildAction,
  type ChildAgeBand,
  type ChildCapability,
  type ChildOverrides,
  type ChildPreset,
  type GuardianRole,
} from "@madeora/domain/permissions";
import { cache } from "react";

import { parseAccentColor, type AccentColor } from "@/accent/accent";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { homeIdSchema } from "@/homes/schema";
import { getHomeContext, type HomeContext } from "@/homes/server";
import { failure } from "@/members/manage-server";
import { optionalNameSchema } from "@/preferences/schema";

/** One child of a Home as the caller may see them (S41). */
export interface HomeChild {
  readonly membershipId: string;
  readonly name: string | null;
  readonly accentColor: AccentColor | null;
  readonly primaryGuardianMembershipId: string | null;
  readonly secondaryGuardianMembershipId: string | null;
  /** Adults asked to become primary / secondary guardian who have not answered yet. */
  readonly pendingPrimaryMembershipId: string | null;
  readonly pendingSecondaryMembershipId: string | null;
  /** The open offers' ids, only when the caller may withdraw them. */
  readonly pendingPrimaryOfferId: string | null;
  readonly pendingSecondaryOfferId: string | null;
  /** The caller may delete this child as a mistaken creation (database decides again). */
  readonly canDelete: boolean;
  /** The caller's guardian role for this child here, or null. */
  readonly myGuardianRole: GuardianRole | null;
  /** Guardians only; `null` for everyone else. */
  readonly access: {
    readonly preset: ChildPreset;
    readonly overrides: ChildOverrides;
    readonly capabilities: readonly ChildCapability[];
    readonly ageBand: ChildAgeBand | null;
    readonly updatedAt: string;
  } | null;
}

export type HomeChildren =
  | { readonly status: "ok"; readonly children: readonly HomeChild[] }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

function isPreset(value: unknown): value is ChildPreset {
  return typeof value === "string" && (childPresets as readonly string[]).includes(value);
}

function isAgeBand(value: unknown): value is ChildAgeBand {
  return typeof value === "string" && (childAgeBands as readonly string[]).includes(value);
}

function parseOverrides(value: unknown): ChildOverrides {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Partial<Record<ChildCapability, boolean>> = {};
  for (const [key, flag] of Object.entries(value)) {
    if (isChildCapability(key) && typeof flag === "boolean") result[key] = flag;
  }
  return result;
}

function parseGuardianRole(value: unknown): GuardianRole | null {
  return value === "primary" || value === "secondary" ? value : null;
}

/**
 * The children of `homeId`, read through `public.home_children` with the person's own session:
 * the function refuses non-members and returns access details only to that child's guardians.
 * Values are re-checked on the way out. Cached for this request only.
 */
export const getHomeChildren = cache(async (homeId: string): Promise<HomeChildren> => {
  const parsedId = homeIdSchema.safeParse(homeId);
  if (!parsedId.success) return { status: "not-found" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("home_children", { p_home_id: parsedId.data });
  if (error?.code === "42501") return { status: "not-found" };
  if (error) {
    console.error(JSON.stringify({ event: "children.read_failed", code: error.code }));
    return { status: "unavailable" };
  }
  const children = data.map((row): HomeChild => {
    const name = optionalNameSchema.safeParse(row.name);
    const myGuardianRole = parseGuardianRole(row.my_guardian_role);
    // Null for anyone who is not this child's guardian, whatever the generated types say.
    const rawCapabilities: unknown = row.capabilities;
    const rawUpdatedAt: unknown = row.settings_updated_at;
    const capabilities = Array.isArray(rawCapabilities)
      ? rawCapabilities.filter(isChildCapability)
      : [];
    return {
      membershipId: row.membership_id,
      name: name.success ? name.data : null,
      accentColor: parseAccentColor(row.accent_color),
      primaryGuardianMembershipId: row.primary_guardian_membership_id,
      secondaryGuardianMembershipId: row.secondary_guardian_membership_id,
      pendingPrimaryMembershipId: row.pending_primary_membership_id,
      pendingSecondaryMembershipId: row.pending_secondary_membership_id,
      pendingPrimaryOfferId: row.pending_primary_offer_id,
      pendingSecondaryOfferId: row.pending_secondary_offer_id,
      canDelete: row.can_delete,
      myGuardianRole,
      access:
        myGuardianRole !== null && isPreset(row.preset) && typeof rawUpdatedAt === "string"
          ? {
              preset: row.preset,
              overrides: parseOverrides(row.overrides),
              capabilities,
              ageBand: isAgeBand(row.age_band) ? row.age_band : null,
              updatedAt: rawUpdatedAt,
            }
          : null,
    };
  });
  return { status: "ok", children };
});

type Allowed<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly response: Response };

/**
 * The caller's membership, the child (read from the database, never from the request) and the
 * engine's answer for `action`. Not a member, or not a child of this Home: 404. Not allowed: 403.
 * The database functions decide again under the Home lock.
 */
export async function requireChildAction(
  homeId: string,
  membershipId: string,
  action: ChildAction,
): Promise<Allowed<{ readonly context: HomeContext; readonly child: HomeChild }>> {
  const found = await getHomeContext(homeId);
  if (found.status === "unavailable") return { ok: false, response: failure(500, "failed") };
  if (found.status === "not-found") return { ok: false, response: failure(404, "not-found") };
  const children = await getHomeChildren(found.context.home.id);
  if (children.status === "unavailable") return { ok: false, response: failure(500, "failed") };
  if (children.status === "not-found") return { ok: false, response: failure(404, "not-found") };
  const child = children.children.find((entry) => entry.membershipId === membershipId);
  if (!child) return { ok: false, response: failure(404, "not-found") };
  const role = found.context.membership.role;
  const allowed = decideChildAction(
    {
      homeRole: isHomeRole(role) ? role : null,
      guardianRole: child.myGuardianRole,
      hasPrimaryGuardian: child.primaryGuardianMembershipId !== null,
    },
    action,
  );
  if (!allowed) return { ok: false, response: failure(403, "not-permitted") };
  return { ok: true, context: found.context, child };
}

/** A guardian role offered to the caller in this Home (S41). */
export interface GuardianOffer {
  readonly offerId: string;
  readonly childMembershipId: string;
  readonly childName: string | null;
  readonly role: GuardianRole;
  readonly expiresAt: string;
}

/** The open guardian offers made to the caller in `homeId`; empty when unreadable. */
export const getMyGuardianOffers = cache(
  async (homeId: string): Promise<readonly GuardianOffer[]> => {
    const parsedId = homeIdSchema.safeParse(homeId);
    if (!parsedId.success) return [];
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("my_child_guardian_offers", {
      p_home_id: parsedId.data,
    });
    if (error) {
      if (error.code !== "42501") {
        console.error(JSON.stringify({ event: "children.offers_read_failed", code: error.code }));
      }
      return [];
    }
    return data.flatMap((row): GuardianOffer[] => {
      const role = parseGuardianRole(row.role);
      if (role === null) return [];
      const name = optionalNameSchema.safeParse(row.child_name);
      return [
        {
          offerId: row.offer_id,
          childMembershipId: row.child_membership_id,
          childName: name.success ? name.data : null,
          role,
          expiresAt: row.expires_at,
        },
      ];
    });
  },
);

/** When the child's open link code in `homeId` expires, for its primary guardian; else null. */
export async function getChildLinkCodeExpiry(
  homeId: string,
  membershipId: string,
): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("child_link_code_state", {
    p_home_id: homeId,
    p_child_membership_id: membershipId,
  });
  if (error) {
    console.error(JSON.stringify({ event: "children.link_state_failed", code: error.code }));
    return null;
  }
  const value: unknown = data;
  return typeof value === "string" ? value : null;
}
