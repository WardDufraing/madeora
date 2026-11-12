import "server-only";

import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

/**
 * Hashes a child's password or PIN (S42) with scrypt, here in the web server, so neither ever
 * reaches the database, its logs or the audit trail; the database stores and checks only the
 * format `scrypt$15$8$1$<salt>$<key>` (`private.is_child_secret_hash`).
 *
 * N = 2^15, r = 8, p = 1 (32 MiB, about a tenth of a second): a stolen hash of a short PIN still
 * resists guessing far longer than a fast hash would, while the database's lockout keeps online
 * guessing to a handful of tries.
 */

const LOG_N = 15;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const OPTIONS: ScryptOptions = { N: 2 ** LOG_N, r: R, p: P, maxmem: 64 * 1024 * 1024 };
const FORMAT = /^scrypt\$15\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

function scrypt(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(secret.normalize("NFC"), salt, KEY_BYTES, OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** A fresh salted hash of `secret` in the stored format. */
export async function hashChildSecret(secret: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(secret, salt);
  return [
    "scrypt",
    String(LOG_N),
    String(R),
    String(P),
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

/**
 * A hash nobody's secret matches (random, made once per server start), compared against when a
 * username does not exist, so that answer takes as long as a wrong password.
 */
let dummy: Promise<string> | null = null;
export function dummyChildSecretHash(): Promise<string> {
  dummy ??= hashChildSecret(randomBytes(32).toString("base64url"));
  return dummy;
}

/** Whether `secret` matches `stored`, in constant time. A malformed hash never matches. */
export async function verifyChildSecret(secret: string, stored: string): Promise<boolean> {
  const match = FORMAT.exec(stored);
  if (!match?.[1] || !match[2]) return false;
  const expected = Buffer.from(match[2], "base64url");
  const actual = await scrypt(secret, Buffer.from(match[1], "base64url"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
