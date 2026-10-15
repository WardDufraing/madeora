import { describe, expect, it } from "vitest";

import { parseWorkerEnv } from "./env.ts";
import { createWorkerMail } from "./services.ts";

const base = {
  APP_ENV: "production",
  SUPABASE_URL: "https://abcdefghijklmnop.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_" + "a".repeat(30),
};

describe("worker email settings", () => {
  it("sends no email unless configured", () => {
    expect(createWorkerMail(parseWorkerEnv(base))).toBeNull();
    expect(createWorkerMail(parseWorkerEnv({ ...base, EMAIL_TRANSPORT: "off" }))).toBeNull();
  });

  it("builds a Resend transport from the key, sender and app address", () => {
    const env = parseWorkerEnv({
      ...base,
      EMAIL_TRANSPORT: "resend",
      EMAIL_FROM: "Madeora <no-reply@mail.madeora.studio>",
      RESEND_API_KEY: "re_" + "k".repeat(20),
      APP_URL: "https://app.madeora.studio",
    });
    expect(createWorkerMail(env)).not.toBeNull();
  });

  it.each([
    ["RESEND_API_KEY", { EMAIL_FROM: "a@mail.madeora.studio", APP_URL: "https://x.test" }],
    ["EMAIL_FROM", { RESEND_API_KEY: "re_" + "k".repeat(20), APP_URL: "https://x.test" }],
    ["APP_URL", { EMAIL_FROM: "a@mail.madeora.studio", RESEND_API_KEY: "re_" + "k".repeat(20) }],
  ])("names %s when Resend is on without it, never a value", (name, rest) => {
    try {
      parseWorkerEnv({ ...base, EMAIL_TRANSPORT: "resend", ...rest });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain(name);
      expect(String(error)).not.toContain("re_kkkk");
    }
  });

  it("refuses an insecure app address in production and a mail catcher outside development", () => {
    expect(() =>
      parseWorkerEnv({
        ...base,
        EMAIL_TRANSPORT: "resend",
        EMAIL_FROM: "a@mail.madeora.studio",
        RESEND_API_KEY: "re_" + "k".repeat(20),
        APP_URL: "http://app.madeora.studio",
      }),
    ).toThrow("APP_URL");
    expect(() =>
      parseWorkerEnv({
        ...base,
        EMAIL_TRANSPORT: "mailpit",
        EMAIL_FROM: "a@x.test",
        MAILPIT_URL: "http://127.0.0.1:54324",
        APP_URL: "http://127.0.0.1:3000",
      }),
    ).toThrow("EMAIL_TRANSPORT");
  });
});
