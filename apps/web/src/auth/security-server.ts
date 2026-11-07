import "server-only";

import { describeDevice, storedDevice, type DeviceDescription, type SessionView } from "./sessions";
import { createSupabaseServerClient } from "./supabase-server";

/** What Settings › Security shows about the account (S37), read with the person's own session. */
export interface AccountSecurity {
  readonly hasPassword: boolean;
  readonly twoFactor: boolean;
  readonly recoveryCodesLeft: number;
  /** Masked by the database ("a•••@example.com"); the full address never reaches the page. */
  readonly backupEmail: string | null;
  readonly backupEmailPending: string | null;
  readonly accountRecoveryCodesLeft: number;
  /** An account recovery under way: when its wait ends, and whether it may be finished now. */
  readonly recoveryWaitingUntil: string | null;
  readonly recoveryReady: boolean;
}

/** A browser that skips the second factor (S37). */
export interface TrustedDeviceView {
  readonly id: string;
  readonly device: DeviceDescription;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly isCurrent: boolean;
}

export type Loaded<T> =
  { readonly status: "ok"; readonly value: T } | { readonly status: "unavailable" };

function logFailure(event: string, code: string | undefined): void {
  // Privacy-safe: the error code only, no account id.
  console.error(JSON.stringify({ event, code: code ?? null }));
}

export async function getAccountSecurity(): Promise<Loaded<AccountSecurity>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("my_account_security");
  const row = data?.[0];
  if (error || !row) {
    logFailure("security.status_failed", error?.code);
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    value: {
      hasPassword: row.has_password,
      twoFactor: row.two_factor,
      recoveryCodesLeft: row.recovery_codes_left,
      // The generated types do not mark these as nullable; the function returns null for "none".
      backupEmail: row.backup_email || null,
      backupEmailPending: row.backup_email_pending || null,
      accountRecoveryCodesLeft: row.account_recovery_codes_left,
      recoveryWaitingUntil: row.recovery_waiting_until || null,
      recoveryReady: row.recovery_ready,
    },
  };
}

export async function getMyTrustedDevices(): Promise<Loaded<readonly TrustedDeviceView[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_my_trusted_devices");
  if (error) {
    logFailure("security.trusted_devices_failed", error.code);
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    value: data.map((row) => ({
      id: row.id,
      device: storedDevice(row.kind, row.browser, row.platform),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      isCurrent: row.is_current,
    })),
  };
}

export async function getMySessions(): Promise<Loaded<readonly SessionView[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_my_sessions");
  if (error) {
    logFailure("security.sessions_failed", error.code);
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    value: data.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      device: describeDevice(row.user_agent),
      isCurrent: row.is_current,
    })),
  };
}
