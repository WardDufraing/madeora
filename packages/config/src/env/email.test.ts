import { describe, expect, it } from "vitest";

import { emailSettings, getServerEnv } from "./server.ts";

const resend = {
  APP_ENV: "production",
  EMAIL_TRANSPORT: "resend",
  EMAIL_FROM: "Madeora <no-reply@mail.madeora.studio>",
  RESEND_API_KEY: "re_synthetic_123456789",
};

describe("email settings", () => {
  it("is off when nothing is configured", () => {
    expect(emailSettings(getServerEnv({ APP_ENV: "production" }))).toEqual({ transport: "off" });
    expect(emailSettings(getServerEnv({ APP_ENV: "test", EMAIL_TRANSPORT: "off" }))).toEqual({
      transport: "off",
    });
  });

  it("accepts Resend with a key and a sender", () => {
    expect(emailSettings(getServerEnv(resend))).toEqual({
      transport: "resend",
      apiKey: "re_synthetic_123456789",
      from: "Madeora <no-reply@mail.madeora.studio>",
    });
    expect(
      emailSettings(getServerEnv({ ...resend, EMAIL_FROM: "no-reply@mail.madeora.studio" })),
    ).toMatchObject({ transport: "resend", from: "no-reply@mail.madeora.studio" });
  });

  it("names a missing key or sender for Resend, never the values", () => {
    expect(() => getServerEnv({ ...resend, RESEND_API_KEY: undefined })).toThrow(
      "RESEND_API_KEY (missing)",
    );
    expect(() => getServerEnv({ ...resend, EMAIL_FROM: "" })).toThrow("EMAIL_FROM (missing)");
  });

  it.each(["sk_live_abc", "re_short", "Bearer re_abcdefghij"])(
    "refuses a key that is not a Resend key (%s) without printing it",
    (key) => {
      let message = "";
      try {
        getServerEnv({ ...resend, RESEND_API_KEY: key });
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("RESEND_API_KEY (invalid)");
      expect(message).not.toContain(key);
    },
  );

  it.each(["Madeora", "a@b", "Madeora <no-reply@mail.madeora.studio", "x\n<a@b.c>"])(
    "refuses a malformed sender %j",
    (from) => {
      expect(() => getServerEnv({ ...resend, EMAIL_FROM: from })).toThrow("EMAIL_FROM (invalid)");
    },
  );

  it("accepts Mailpit on this machine for development and tests", () => {
    expect(
      emailSettings(
        getServerEnv({
          APP_ENV: "test",
          EMAIL_TRANSPORT: "mailpit",
          MAILPIT_URL: "http://127.0.0.1:54324",
          EMAIL_FROM: "Madeora <no-reply@madeora.test>",
        }),
      ),
    ).toEqual({
      transport: "mailpit",
      url: "http://127.0.0.1:54324",
      from: "Madeora <no-reply@madeora.test>",
    });
  });

  it.each(["preview", "staging", "production"])(
    "refuses Mailpit in a hosted environment (%s), where it would swallow real mail",
    (appEnv) => {
      expect(() =>
        getServerEnv({
          APP_ENV: appEnv,
          EMAIL_TRANSPORT: "mailpit",
          MAILPIT_URL: "http://127.0.0.1:54324",
          EMAIL_FROM: "a@madeora.test",
        }),
      ).toThrow("EMAIL_TRANSPORT (invalid)");
    },
  );

  it("refuses a Mailpit address that is not on this machine", () => {
    expect(() =>
      getServerEnv({
        APP_ENV: "development",
        EMAIL_TRANSPORT: "mailpit",
        MAILPIT_URL: "https://mail.example.com",
        EMAIL_FROM: "a@madeora.test",
      }),
    ).toThrow("MAILPIT_URL (invalid)");
  });
});
