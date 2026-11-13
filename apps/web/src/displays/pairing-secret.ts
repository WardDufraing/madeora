import "server-only";

import { getPublicEnv } from "@madeora/config/env/public";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";

import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "./schema";

/**
 * The tablet's pairing secret (S43). An unregistered tablet keeps a random 32-byte secret in an
 * httpOnly cookie that page scripts cannot read. Its pairing code is derived from the secret, so a
 * refresh shows the same code without the code being stored anywhere; the database keeps only the
 * SHA-256 of the secret and of the code. Only the browser holding the secret can turn a manager's
 * approval into a display session, so knowing the code is not enough to take a display over.
 */

export const DISPLAY_PAIRING_COOKIE = "madeora_display_pairing";
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// Longer than a code lives (10 minutes) plus the claim window after approval (10 minutes).
const MAX_AGE_SECONDS = 30 * 60;

export function newPairingSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The 8-character code of a secret: SHA-256 bytes mapped onto the code alphabet. Rejection
 * sampling keeps every character uniform (the alphabet has 31 letters, a byte 256 values).
 */
export function pairingCodeOf(secret: string): string {
  const limit = 256 - (256 % PAIRING_CODE_ALPHABET.length);
  let code = "";
  for (let round = 0; code.length < PAIRING_CODE_LENGTH; round += 1) {
    const bytes = createHash("sha256")
      .update(`madeora-display-code:${String(round)}:${secret}`)
      .digest();
    for (const byte of bytes) {
      if (byte >= limit) continue;
      code += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length] ?? "";
      if (code.length === PAIRING_CODE_LENGTH) break;
    }
  }
  return code;
}

/** What the database stores of a code: the SHA-256 of its normalized form. */
export function pairingCodeHash(code: string): string {
  return sha256Hex(`madeora-display-code:${code}`);
}

/** This browser's pairing secret, or `null` when it has none (or a malformed one). */
export async function currentPairingSecret(): Promise<string | null> {
  const value = (await cookies()).get(DISPLAY_PAIRING_COOKIE)?.value;
  return value && SECRET_PATTERN.test(value) ? value : null;
}

/** Puts the pairing cookie on this response (route handlers only). */
export async function setPairingCookie(secret: string): Promise<void> {
  (await cookies()).set(DISPLAY_PAIRING_COOKIE, secret, {
    httpOnly: true,
    sameSite: "strict",
    secure: new URL(getPublicEnv().NEXT_PUBLIC_APP_URL).protocol === "https:",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function clearPairingCookie(): Promise<void> {
  (await cookies()).delete(DISPLAY_PAIRING_COOKIE);
}
