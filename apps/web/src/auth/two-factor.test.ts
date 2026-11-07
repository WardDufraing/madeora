import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";

import {
  classifyTwoFactorError,
  looksLikeRecoveryCode,
  needsSecondFactor,
  normaliseRecoveryCode,
  readAccessTokenClaims,
  verifiedTotpFactor,
} from "./two-factor";

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "HS256" })}.${encode(payload)}.signature`;
}

const totp = (status: "verified" | "unverified") => ({
  id: `factor-${status}`,
  factor_type: "totp" as const,
  status,
  created_at: "",
  updated_at: "",
});

describe("two-factor helpers", () => {
  it("finds only a verified authenticator", () => {
    expect(verifiedTotpFactor({ factors: [] })).toBeNull();
    expect(verifiedTotpFactor({ factors: [totp("unverified")] })).toBeNull();
    expect(verifiedTotpFactor({ factors: [totp("unverified"), totp("verified")] })?.id).toBe(
      "factor-verified",
    );
  });

  it("reads the assurance level and session id of an accepted token", () => {
    expect(readAccessTokenClaims(token({ aal: "aal2", session_id: "s-1" }))).toEqual({
      aal: "aal2",
      sessionId: "s-1",
    });
    expect(readAccessTokenClaims("not-a-jwt")).toEqual({ aal: null, sessionId: null });
    expect(readAccessTokenClaims("a.%%%.c")).toEqual({ aal: null, sessionId: null });
  });

  it("asks for the second factor only for an aal1 session of an account that has one", () => {
    const withFactor = { factors: [totp("verified")] };
    expect(needsSecondFactor(withFactor, token({ aal: "aal1" }))).toBe(true);
    expect(needsSecondFactor(withFactor, token({ aal: "aal2" }))).toBe(false);
    expect(needsSecondFactor({ factors: [totp("unverified")] }, token({ aal: "aal1" }))).toBe(
      false,
    );
    expect(needsSecondFactor({}, token({ aal: "aal1" }))).toBe(false);
    // A token whose claims cannot be read never counts as having passed the second factor.
    expect(needsSecondFactor(withFactor, "garbage")).toBe(true);
  });

  it("normalises recovery codes the way the database does", () => {
    expect(normaliseRecoveryCode(" abcd-efgh jkmn ")).toBe("ABCDEFGHJKMN");
    expect(looksLikeRecoveryCode("abcd-efgh-jkmn")).toBe(true);
    expect(looksLikeRecoveryCode("ABCD-EFGH-JKM0")).toBe(false);
    expect(looksLikeRecoveryCode("short")).toBe(false);
  });

  it.each([
    [new AuthApiError("bad", 422, "mfa_verification_failed"), "wrongCode"],
    [new AuthApiError("old", 422, "mfa_challenge_expired"), "expired"],
    [new AuthApiError("slow", 429, "over_request_rate_limit"), "rateLimited"],
    [new AuthApiError("db", 500, "unexpected_failure"), "tryLater"],
    [new AuthRetryableFetchError("offline", 0), "network"],
    [new TypeError("fetch failed"), "network"],
    [new Error("other"), "unknown"],
  ])("classifies %s", (error, expected) => {
    expect(classifyTwoFactorError(error)).toBe(expected);
  });
});
