import { describe, expect, it } from "vitest";

import { emailEnabled, getServerEnv } from "./server.ts";

describe("email settings in the web app", () => {
  it("is off when nothing is configured", () => {
    expect(emailEnabled(getServerEnv({ APP_ENV: "production" }))).toBe(false);
    expect(emailEnabled(getServerEnv({ APP_ENV: "test", EMAIL_TRANSPORT: "off" }))).toBe(false);
  });

  it("is on for Resend and for Mailpit, without any provider secret in the web app", () => {
    expect(emailEnabled(getServerEnv({ APP_ENV: "production", EMAIL_TRANSPORT: "resend" }))).toBe(
      true,
    );
    expect(emailEnabled(getServerEnv({ APP_ENV: "test", EMAIL_TRANSPORT: "mailpit" }))).toBe(true);
  });

  it("never holds the provider key: a key in the environment is not read", () => {
    const env = getServerEnv({
      APP_ENV: "production",
      EMAIL_TRANSPORT: "resend",
      RESEND_API_KEY: "re_synthetic_123456789",
    });
    expect(JSON.stringify(env)).not.toContain("re_synthetic");
  });

  it("refuses an unknown transport, naming the variable", () => {
    expect(() => getServerEnv({ APP_ENV: "test", EMAIL_TRANSPORT: "smtp" })).toThrow(
      "EMAIL_TRANSPORT (invalid)",
    );
  });

  it.each(["preview", "staging", "production"])(
    "refuses Mailpit in a hosted environment (%s), where it would swallow real mail",
    (APP_ENV) => {
      expect(() => getServerEnv({ APP_ENV, EMAIL_TRANSPORT: "mailpit" })).toThrow(
        "EMAIL_TRANSPORT (invalid)",
      );
    },
  );
});
