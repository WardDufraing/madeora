import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SealError, open, openRefreshToken, seal, sealRefreshToken } from "./crypto.ts";

const key = randomBytes(32);
const alice = "10000000-0000-4000-8000-000000000001";
const bob = "10000000-0000-4000-8000-000000000002";

describe("sealing refresh tokens", () => {
  it("opens what it sealed, in the stored shape, never containing the token", () => {
    const sealed = sealRefreshToken("1//refresh-token", key, alice);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    expect(sealed).not.toContain("refresh-token");
    expect(openRefreshToken(sealed, key, alice)).toBe("1//refresh-token");
  });

  it("uses a fresh IV every time", () => {
    expect(sealRefreshToken("same", key, alice)).not.toBe(sealRefreshToken("same", key, alice));
  });

  it("refuses another person's token, another key, a tampered value and a malformed one", () => {
    const sealed = sealRefreshToken("1//refresh-token", key, alice);
    expect(() => openRefreshToken(sealed, key, bob)).toThrow(SealError);
    expect(() => openRefreshToken(sealed, randomBytes(32), alice)).toThrow(SealError);
    const parts = sealed.split(".");
    const body = Buffer.from(parts[2] ?? "", "base64url");
    body[0] = (body[0] ?? 0) ^ 1;
    const tampered = [parts[0], parts[1], body.toString("base64url"), parts[3]].join(".");
    expect(() => openRefreshToken(tampered, key, alice)).toThrow(SealError);
    expect(() => openRefreshToken("not-sealed", key, alice)).toThrow(SealError);
  });

  it("binds a value to its purpose", () => {
    const sealed = seal("state", key, "purpose-a");
    expect(open(sealed, key, "purpose-a")).toBe("state");
    expect(() => open(sealed, key, "purpose-b")).toThrow(SealError);
  });

  it("refuses a key of the wrong size", () => {
    expect(() => seal("x", randomBytes(16), "p")).toThrow("32 bytes");
  });
});
