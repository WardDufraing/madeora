/**
 * Sealing secrets at rest (S33, architecture.md §31): AES-256-GCM with a random 96-bit IV and a purpose
 * string as associated data, so a sealed value only opens for the purpose (and person) it was sealed for.
 * A refresh token is bound to its person's id: a row copied to another person cannot be used. The format
 * `v1.<iv>.<ciphertext>.<tag>` (base64url) leaves room for a key rotation later (`v2`).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class SealError extends Error {
  constructor() {
    super("sealed value cannot be opened");
    this.name = "SealError";
  }
}

const VERSION = "v1";
const FORMAT = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/;

function checkKey(key: Buffer): void {
  if (key.length !== 32) throw new Error("the key must be 32 bytes");
}

export function seal(plaintext: string, key: Buffer, purpose: string): string {
  checkKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    body.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

/** Throws SealError for anything tampered with, sealed with another key or for another purpose. */
export function open(sealed: string, key: Buffer, purpose: string): string {
  checkKey(key);
  const match = FORMAT.exec(sealed);
  if (!match) throw new SealError();
  const [, iv = "", body = "", tag = ""] = match;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(purpose, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(body, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SealError();
  }
}

const refreshPurpose = (userId: string) => `madeora:google-calendar:refresh-token:${userId}`;

export function sealRefreshToken(token: string, key: Buffer, userId: string): string {
  return seal(token, key, refreshPurpose(userId));
}

export function openRefreshToken(sealed: string, key: Buffer, userId: string): string {
  return open(sealed, key, refreshPurpose(userId));
}
