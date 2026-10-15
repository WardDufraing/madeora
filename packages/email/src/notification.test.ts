import { describe, expect, it } from "vitest";

import { emailLocales } from "./messages.ts";
import {
  isOptionalNotificationKind,
  notificationKinds,
  notificationMessages,
} from "./notification-messages.ts";
import { renderNotificationEmail } from "./render.ts";

const url = "https://app.madeora.test/homes/6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001/recovery";

describe("notification messages", () => {
  it("has every kind, with the same placeholders, in every language", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const locale of emailLocales) {
      const kinds = notificationMessages[locale].kinds;
      expect(Object.keys(kinds).sort()).toEqual([...notificationKinds].sort());
      for (const kind of notificationKinds) {
        for (const field of ["subject", "preview", "heading", "body", "button"] as const) {
          expect(placeholders(kinds[kind][field]), `${locale} ${kind} ${field}`).toEqual(
            placeholders(notificationMessages.en.kinds[kind][field]),
          );
          expect(kinds[kind][field].length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("renderNotificationEmail", () => {
  it.each(
    emailLocales.flatMap((locale) => notificationKinds.map((kind) => [locale, kind] as const)),
  )(
    "renders %s %s as HTML and plain text with the link and no loose placeholder",
    async (locale, kind) => {
      const email = await renderNotificationEmail({
        kind,
        locale,
        homeName: "De Boomgaard",
        url,
        date: new Date("2026-10-29T16:00:00Z"),
        timeZone: "Europe/Brussels",
      });
      expect(email.subject.length).toBeGreaterThan(0);
      expect(email.html).toContain(`lang="${locale}"`);
      expect(email.html).toContain(`href="${url}"`);
      expect(email.text).toContain(url);
      for (const part of [email.subject, email.html, email.text]) {
        expect(part).not.toMatch(/\{(home|date)\}/);
      }
    },
  );

  it("gives the end of the objection period in the Home's timezone", async () => {
    const email = await renderNotificationEmail({
      kind: "recovery.claimant_approved",
      locale: "en",
      homeName: "De Boomgaard",
      url,
      date: new Date("2026-10-29T16:00:00Z"),
      timeZone: "Europe/Brussels",
    });
    expect(email.text.toLowerCase()).toContain("october 29, 2026");
    expect(email.text).toContain("17:00");
  });

  it("inserts the Home's name as text, never as HTML", async () => {
    const email = await renderNotificationEmail({
      kind: "recovery.claimant_rejected",
      locale: "en",
      homeName: "<script>alert(1)</script>",
      url,
      date: null,
      timeZone: "UTC",
    });
    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("says security messages cannot be switched off and optional ones can be chosen", async () => {
    const security = await renderNotificationEmail({
      kind: "recovery.claimant_paused",
      locale: "en",
      homeName: "Thuis",
      url,
      date: null,
      timeZone: "UTC",
    });
    const optional = await renderNotificationEmail({
      kind: "join_request.received",
      locale: "en",
      homeName: "Thuis",
      url,
      date: null,
      timeZone: "UTC",
    });
    expect(security.text).toContain("cannot be switched off");
    expect(optional.text).toContain("Settings");
    expect(isOptionalNotificationKind("join_request.received")).toBe(true);
    expect(isOptionalNotificationKind("recovery.claimant_paused")).toBe(false);
  });
});
