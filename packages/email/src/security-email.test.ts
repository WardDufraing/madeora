import { describe, expect, it } from "vitest";

import { renderSecurityEmail } from "./render.ts";
import { securityEmailMessages, type SecurityEmailKind } from "./security-email.tsx";

const kinds: readonly SecurityEmailKind[] = [
  "backup_verify",
  "recovery_link",
  "recovery_started",
  "recovery_ready",
];

describe("security emails", () => {
  it.each(["en", "nl"] as const)(
    "renders every kind in %s as HTML and plain text",
    async (locale) => {
      for (const kind of kinds) {
        const url = kind === "recovery_started" ? null : "https://app.madeora.test/x?token=abc";
        const email = await renderSecurityEmail({ kind, locale, url, expiresAt: null });
        expect(email.subject).toBe(securityEmailMessages[locale][kind].subject);
        expect(email.html).toContain(`lang="${locale}"`);
        expect(email.text).toContain(securityEmailMessages[locale][kind].body.slice(0, 40));
        if (url) expect(email.text).toContain(url);
      }
    },
  );

  it("refuses a link email without its link", async () => {
    await expect(
      renderSecurityEmail({ kind: "recovery_link", locale: "en", url: null, expiresAt: null }),
    ).rejects.toThrow();
  });

  it("names no account, address or Home", async () => {
    const email = await renderSecurityEmail({
      kind: "recovery_started",
      locale: "en",
      url: null,
      expiresAt: null,
    });
    expect(email.text).not.toMatch(/@/);
  });
});
