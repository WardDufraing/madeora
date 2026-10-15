import { describe, expect, it } from "vitest";

import { emailLocales, recoveryMessages } from "./messages.ts";
import { renderOwnershipRecoveryEmail } from "./render.ts";

const base = {
  homeName: "De Boomgaard",
  url: "https://app.madeora.test/homes/6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001",
  objectionEndsAt: new Date("2026-10-29T16:00:00Z"),
  timeZone: "Europe/Brussels",
} as const;

describe("recovery messages", () => {
  it("has the same keys and placeholders in every language", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const en = recoveryMessages.en;
    for (const locale of emailLocales) {
      const messages = recoveryMessages[locale];
      expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort());
      for (const key of Object.keys(en) as (keyof typeof en)[]) {
        expect(placeholders(messages[key]), `${locale}.${key}`).toEqual(placeholders(en[key]));
      }
    }
  });
});

describe("renderOwnershipRecoveryEmail", () => {
  it("tells the Owner a review started and how to stop it, in HTML and plain text", async () => {
    const email = await renderOwnershipRecoveryEmail({
      ...base,
      kind: "review_started",
      locale: "en",
      objectionEndsAt: null,
    });
    expect(email.subject).toBe("Someone asked to take over ownership of ⁨De Boomgaard⁩ on Madeora");
    expect(email.html).toContain('lang="en"');
    expect(email.html).toContain(`href="${base.url}"`);
    expect(email.text).toContain("I still have access");
    expect(email.text).toContain("started checking");
    expect(email.text).toContain(base.url);
  });

  it("gives the end of the objection period in the Home's timezone when approved", async () => {
    const email = await renderOwnershipRecoveryEmail({ ...base, kind: "approved", locale: "en" });
    expect(email.subject).toBe("Ownership of ⁨De Boomgaard⁩ on Madeora will move unless you act");
    expect(email.text.toLowerCase()).toContain("october 29, 2026");
    expect(email.text).toContain("17:00");
  });

  it("renders Dutch", async () => {
    const email = await renderOwnershipRecoveryEmail({ ...base, kind: "approved", locale: "nl" });
    expect(email.html).toContain('lang="nl"');
    expect(email.text).toContain("Ik heb nog toegang");
    expect(email.text.toLowerCase()).toContain("29 oktober 2026");
  });

  it("refuses an approved email without the date", async () => {
    await expect(
      renderOwnershipRecoveryEmail({
        ...base,
        kind: "approved",
        locale: "en",
        objectionEndsAt: null,
      }),
    ).rejects.toThrow();
  });

  it("escapes a Home name that looks like HTML and names nobody", async () => {
    const email = await renderOwnershipRecoveryEmail({
      ...base,
      kind: "review_started",
      locale: "en",
      homeName: '<img src=x onerror="alert(1)">',
    });
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("&lt;img");
    expect(email.text).not.toMatch(/@/);
  });
});
