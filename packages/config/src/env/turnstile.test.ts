import { describe, expect, it } from "vitest";

import {
  checkPublicEnvForBuild,
  getPublicEnv,
  getTurnstileSiteKey,
  isTurnstileSiteKey,
} from "./public.ts";

const base = {
  NEXT_PUBLIC_APP_URL: "https://madeora.test",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.test",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic",
};
// Cloudflare's documented test keys: a site key that always passes, and its secret counterpart.
const testSiteKey = "1x00000000000000000000AA";
const testSecretKey = "1x0000000000000000000000000000000AA";

describe("isTurnstileSiteKey", () => {
  it("accepts site keys", () => {
    expect(isTurnstileSiteKey(testSiteKey)).toBe(true);
    expect(isTurnstileSiteKey("0x4AAAAAAABkMYinukE8nzYS")).toBe(true);
  });

  it("refuses secret keys and other values", () => {
    expect(isTurnstileSiteKey(testSecretKey)).toBe(false);
    expect(isTurnstileSiteKey("")).toBe(false);
    expect(isTurnstileSiteKey("x00000000000000000000AA")).toBe(false);
    expect(isTurnstileSiteKey("1x0000000000000000000<AA")).toBe(false);
  });
});

describe("NEXT_PUBLIC_TURNSTILE_SITE_KEY", () => {
  it("is optional outside production", () => {
    expect(getPublicEnv(base).NEXT_PUBLIC_TURNSTILE_SITE_KEY).toBeUndefined();
    expect(checkPublicEnvForBuild({ ...base, VERCEL_ENV: "preview" })).toMatchObject(base);
  });

  it("is passed through when set", () => {
    const env = getPublicEnv({ ...base, NEXT_PUBLIC_TURNSTILE_SITE_KEY: testSiteKey });
    expect(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY).toBe(testSiteKey);
  });

  it("refuses a secret key without printing it", () => {
    let message = "";
    try {
      getPublicEnv({ ...base, NEXT_PUBLIC_TURNSTILE_SITE_KEY: testSecretKey });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("NEXT_PUBLIC_TURNSTILE_SITE_KEY (invalid)");
    expect(message).not.toContain(testSecretKey);
  });

  it("is required for a Vercel production build", () => {
    expect(() => checkPublicEnvForBuild({ ...base, VERCEL_ENV: "production" })).toThrow(
      "NEXT_PUBLIC_TURNSTILE_SITE_KEY (missing)",
    );
  });

  it("is required when APP_ENV is production", () => {
    expect(() => checkPublicEnvForBuild({ ...base, APP_ENV: "production" })).toThrow(
      "NEXT_PUBLIC_TURNSTILE_SITE_KEY (missing)",
    );
    expect(
      checkPublicEnvForBuild({
        ...base,
        APP_ENV: "production",
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: testSiteKey,
      }).NEXT_PUBLIC_TURNSTILE_SITE_KEY,
    ).toBe(testSiteKey);
  });
});

describe("getTurnstileSiteKey", () => {
  it("returns the key, or undefined when unset or empty", () => {
    expect(getTurnstileSiteKey(testSiteKey)).toBe(testSiteKey);
    expect(getTurnstileSiteKey(undefined)).toBeUndefined();
    expect(getTurnstileSiteKey("")).toBeUndefined();
  });

  it("names an invalid key without its value", () => {
    expect(() => getTurnstileSiteKey(testSecretKey)).toThrow(
      "NEXT_PUBLIC_TURNSTILE_SITE_KEY (invalid)",
    );
  });
});
