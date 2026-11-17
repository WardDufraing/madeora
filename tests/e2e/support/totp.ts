import { createHmac } from "node:crypto";

/**
 * A minimal RFC 6238 authenticator (SHA-1, 6 digits, 30-second steps, the defaults Supabase Auth
 * uses), so tests can answer two-factor sign-in like a phone app would. Test-only.
 */
function base32Decode(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/, "").toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("not a base32 secret");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

const lastCode = new Map<string, string>();

/**
 * A code that is safe to submit now: it stays valid long enough (when fewer than eight seconds
 * remain in the 30-second step, wait for the next one, because a slow runner can spend the rest of
 * the step between filling the code and the server checking it). With `distinct`, it is also never
 * the code this secret was last answered with: authenticators may refuse a code they have already
 * accepted, and two sign-ins within one step would otherwise present the same one.
 */
export async function freshTotp(secret: string, distinct = false): Promise<string> {
  for (;;) {
    const remaining = 30_000 - (Date.now() % 30_000);
    if (remaining < 8_000) {
      await new Promise((resolve) => setTimeout(resolve, remaining + 250));
      continue;
    }
    const code = totp(secret);
    if (!distinct || code !== lastCode.get(secret)) {
      lastCode.set(secret, code);
      return code;
    }
    await new Promise((resolve) => setTimeout(resolve, remaining + 250));
  }
}
