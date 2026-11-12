import "server-only";

import { getPublicEnv } from "@madeora/config/env/public";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";

/**
 * The approved-household-device cookie (S42). A Home manager approves the browser they are using;
 * it then carries a random 32-byte secret in an httpOnly cookie that page scripts cannot read. The
 * database stores only the secret's SHA-256 (`private.household_devices`), so a database read
 * cannot be turned into an approved device.
 */

export const HOUSEHOLD_DEVICE_COOKIE = "madeora_household_device";
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// Browsers cap cookie lifetimes at 400 days.
const MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

export function newDeviceSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function deviceSecretHash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** The hash of this browser's device cookie, or `null` when it has none (or a malformed one). */
export async function currentDeviceHash(): Promise<string | null> {
  const value = (await cookies()).get(HOUSEHOLD_DEVICE_COOKIE)?.value;
  return value && SECRET_PATTERN.test(value) ? deviceSecretHash(value) : null;
}

/** Puts the device cookie on this response (route handlers only). */
export async function setDeviceCookie(secret: string): Promise<void> {
  (await cookies()).set(HOUSEHOLD_DEVICE_COOKIE, secret, {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(getPublicEnv().NEXT_PUBLIC_APP_URL).protocol === "https:",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function clearDeviceCookie(): Promise<void> {
  (await cookies()).delete(HOUSEHOLD_DEVICE_COOKIE);
}
