import { pairingCodeHash, pairingCodeOf, newPairingSecret, sha256Hex } from "./pairing-secret";
import { normalizePairingCode, PAIRING_CODE_ALPHABET } from "./schema";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }) }));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

describe("pairing secret and code", () => {
  it("makes a fresh 32-byte secret every time", () => {
    const first = newPairingSecret();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newPairingSecret()).not.toBe(first);
  });

  it("derives the same 8-character code from the same secret, so a refresh shows it again", () => {
    const secret = newPairingSecret();
    const code = pairingCodeOf(secret);
    expect(code).toHaveLength(8);
    expect(pairingCodeOf(secret)).toBe(code);
    expect(normalizePairingCode(code)).toBe(code);
    for (const character of code) expect(PAIRING_CODE_ALPHABET).toContain(character);
  });

  it("spreads codes over the whole alphabet", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 400; index += 1) {
      for (const character of pairingCodeOf(newPairingSecret())) seen.add(character);
    }
    expect(seen.size).toBe(PAIRING_CODE_ALPHABET.length);
  });

  it("stores only hashes, and the code's hash is not the secret's", () => {
    const secret = newPairingSecret();
    const code = pairingCodeOf(secret);
    expect(sha256Hex(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(pairingCodeHash(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(pairingCodeHash(code)).not.toBe(sha256Hex(code));
    expect(pairingCodeHash(code)).not.toBe(sha256Hex(secret));
  });
});
