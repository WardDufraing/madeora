import "server-only";

import { isChildCapability, type ChildCapability } from "@madeora/domain/permissions";
import { cache } from "react";

import { parseAccentColor, type AccentColor } from "@/accent/accent";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { homeIdSchema } from "@/homes/schema";

import { currentDeviceHash } from "./device";

/** A child's sign-in as one of their guardians sees it (S42). Never a hash, PIN or password. */
export interface ChildSignInSettings {
  readonly username: string | null;
  readonly hasPassword: boolean;
  readonly hasPin: boolean;
  readonly passwordSignIn: boolean;
  readonly pinSignIn: boolean;
  /** When the lock ends; `"guardian"` when only a guardian can lift it. */
  readonly passwordLockedUntil: string | null;
  readonly pinLockedUntil: string | null;
  readonly activeSessions: number;
  readonly canManageIdentity: boolean;
}

function lockEnd(value: string | null): string | null {
  if (value === null) return null;
  return value === "infinity" ? "guardian" : value;
}

/** For the child's guardians only; `null` for anyone else (the database decides). */
export const getChildSignInSettings = cache(
  async (homeId: string, membershipId: string): Promise<ChildSignInSettings | null> => {
    if (!homeIdSchema.safeParse(homeId).success || !homeIdSchema.safeParse(membershipId).success) {
      return null;
    }
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("child_sign_in_settings", {
      p_home_id: homeId,
      p_child_membership_id: membershipId,
    });
    if (error) {
      if (error.code !== "42501") {
        console.error(JSON.stringify({ event: "child_sign_in.settings_failed", code: error.code }));
      }
      return null;
    }
    const row = data[0];
    if (!row) return null;
    return {
      username: row.username,
      hasPassword: row.has_password,
      hasPin: row.has_pin,
      passwordSignIn: row.password_sign_in,
      pinSignIn: row.pin_sign_in,
      passwordLockedUntil: lockEnd(row.password_locked_until),
      pinLockedUntil: lockEnd(row.pin_locked_until),
      activeSessions: row.active_sessions,
      canManageIdentity: row.can_manage_identity,
    };
  },
);

export interface HouseholdDevice {
  readonly id: string;
  readonly label: string;
  readonly approvedByMembershipId: string | null;
  readonly approvedAt: string;
  readonly lastUsedAt: string | null;
  readonly isThisDevice: boolean;
}

/** The Home's approved devices, for its managers; `null` for anyone else. */
export const getHouseholdDevices = cache(
  async (homeId: string): Promise<readonly HouseholdDevice[] | null> => {
    if (!homeIdSchema.safeParse(homeId).success) return null;
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("home_household_devices", {
      p_home_id: homeId,
      p_current_hash: (await currentDeviceHash()) ?? "",
    });
    if (error) {
      if (error.code !== "42501") {
        console.error(JSON.stringify({ event: "household_devices.read_failed", code: error.code }));
      }
      return null;
    }
    return data.map((row) => ({
      id: row.device_id,
      label: row.label,
      approvedByMembershipId: row.approved_by_membership_id,
      approvedAt: row.approved_at,
      lastUsedAt: row.last_used_at,
      isThisDevice: row.is_this_device,
    }));
  },
);

export interface ChildSessionHome {
  readonly homeId: string;
  readonly homeName: string;
  readonly displayName: string | null;
  readonly accentColor: AccentColor | null;
  readonly capabilities: readonly ChildCapability[];
}

export interface ChildSession {
  readonly method: "password" | "pin";
  readonly expiresAt: string;
  readonly homes: readonly ChildSessionHome[];
}

/** The signed-in child's session (`public.child_me`), or `null` when it is not usable. */
export const getChildSession = cache(async (): Promise<ChildSession | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("child_me");
  if (error) {
    if (error.code !== "42501" && error.code !== "PGRST301") {
      console.error(JSON.stringify({ event: "child_session.read_failed", code: error.code }));
    }
    return null;
  }
  const first = data[0];
  if (!first || (first.method !== "password" && first.method !== "pin")) return null;
  return {
    method: first.method,
    expiresAt: first.session_expires_at,
    homes: data.map((row) => ({
      homeId: row.home_id,
      homeName: row.home_name,
      displayName: row.display_name,
      accentColor: parseAccentColor(row.accent_color),
      capabilities: row.capabilities.filter(isChildCapability),
    })),
  };
});

/** Whether the Home asks for a PIN on its household devices; `null` for anyone but its managers. */
export const getSharedDevicePinRule = cache(async (homeId: string): Promise<boolean | null> => {
  if (!homeIdSchema.safeParse(homeId).success) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("shared_device_pin_rule", { p_home_id: homeId });
  if (error) {
    if (error.code !== "42501") {
      console.error(
        JSON.stringify({ event: "shared_device_pin_rule.read_failed", code: error.code }),
      );
    }
    return null;
  }
  return data;
});

/** The signed-in adult's own household-device PIN: set or not, and its lock. Never the hash. */
export interface MyDevicePin {
  readonly hasPin: boolean;
  readonly lockedUntil: string | null;
}

export const getMyDevicePin = cache(async (): Promise<MyDevicePin | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("my_device_pin");
  if (error) {
    console.error(JSON.stringify({ event: "my_device_pin.read_failed", code: error.code }));
    return null;
  }
  const row = data[0];
  return { hasPin: row?.has_pin ?? false, lockedUntil: row?.locked_until ?? null };
});
