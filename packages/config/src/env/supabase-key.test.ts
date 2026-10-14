import { describe, expect, it } from "vitest";
import { EnvValidationError, parseEnv } from "./core.ts";
import { isPrivilegedSupabaseKey, publicEnvSchema } from "./public.ts";

// Synthetic JWT-shaped keys: header.payload.signature with a made-up signature.
function jwtKey(payload: object): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.synthetic-signature`;
}

const base = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
};

describe("isPrivilegedSupabaseKey", () => {
  it.each([
    ["a publishable key", "sb_publishable_synthetic-test-value", false],
    ["a legacy anon key", jwtKey({ iss: "supabase-demo", role: "anon" }), false],
    ["a secret key", "sb_secret_synthetic-test-value", true],
    ["a legacy service_role key", jwtKey({ iss: "supabase-demo", role: "service_role" }), true],
    ["a JWT for any other role", jwtKey({ role: "supabase_admin" }), true],
    ["a JWT without a role", jwtKey({ iss: "x" }), false],
    ["three parts that are not JSON", "a.b.c", false],
  ])("%s → %s", (_name, key, expected) => {
    expect(isPrivilegedSupabaseKey(key)).toBe(expected);
  });
});

describe("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", () => {
  it("accepts a publishable key", () => {
    const env = { ...base, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic" };
    expect(parseEnv(publicEnvSchema, env)).toEqual(env);
  });

  it.each([
    ["sb_secret_should-never-be-printed"],
    [jwtKey({ role: "service_role", marker: "never-printed" })],
  ])("refuses a privileged key and never prints it", (key) => {
    let error: unknown;
    try {
      parseEnv(publicEnvSchema, { ...base, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    expect(String(error)).toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (invalid)");
    expect(String(error)).not.toContain(key);
  });

  it("names a missing Supabase URL and key", () => {
    expect(() =>
      parseEnv(publicEnvSchema, { NEXT_PUBLIC_APP_URL: base.NEXT_PUBLIC_APP_URL }),
    ).toThrow("NEXT_PUBLIC_SUPABASE_URL (missing), NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (missing)");
  });

  it("refuses a key with characters a key never has", () => {
    expect(() =>
      parseEnv(publicEnvSchema, {
        ...base,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "key with spaces",
      }),
    ).toThrow("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (invalid)");
  });
});

describe("NEXT_PUBLIC_SUPABASE_URL", () => {
  const key = { NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic" };

  it.each([["http://127.0.0.1:54321"], ["https://abcdefghijklmnop.supabase.co"]])(
    "accepts the project address %s",
    (url) => {
      const env = { ...base, ...key, NEXT_PUBLIC_SUPABASE_URL: url };
      expect(parseEnv(publicEnvSchema, env)).toEqual(env);
    },
  );

  it.each([
    ["https://abcdefghijklmnop.supabase.co/rest/v1/"],
    ["https://abcdefghijklmnop.supabase.co/"],
    ["https://abcdefghijklmnop.supabase.co?x=1"],
  ])("refuses %s, which has more than scheme and host", (url) => {
    expect(() =>
      parseEnv(publicEnvSchema, { ...base, ...key, NEXT_PUBLIC_SUPABASE_URL: url }),
    ).toThrow("NEXT_PUBLIC_SUPABASE_URL (invalid)");
  });
});
