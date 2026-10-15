import { describe, expect, it, vi } from "vitest";

import { formatExpiry } from "./home-invitation.tsx";
import { emailLocales, fill, invitationMessages, isEmailLocale } from "./messages.ts";
import { renderHomeInvitationEmail } from "./render.ts";
import { createMailpitTransport, createResendTransport, type OutgoingEmail } from "./transport.ts";

const base = {
  homeName: "De Boomgaard",
  role: "member",
  recipientEmail: "sam@madeora.test",
  url: "https://app.madeora.test/join/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde",
  expiresAt: new Date("2026-10-21T16:00:00Z"),
  timeZone: "Europe/Brussels",
} as const;

describe("invitation messages", () => {
  it("has the same keys and placeholders in every language", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const en = invitationMessages.en;
    for (const locale of emailLocales) {
      const messages = invitationMessages[locale];
      expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort());
      for (const key of Object.keys(en) as (keyof typeof en)[]) {
        expect(placeholders(messages[key]), `${locale}.${key}`).toEqual(placeholders(en[key]));
      }
    }
  });

  it("fills placeholders and leaves unknown ones visible", () => {
    expect(fill("Hi {name}, {other}", { name: "Sam" })).toBe("Hi Sam, {other}");
  });

  it("knows its languages", () => {
    expect(isEmailLocale("nl")).toBe(true);
    expect(isEmailLocale("fr")).toBe(false);
    expect(isEmailLocale(undefined)).toBe(false);
  });
});

describe("renderHomeInvitationEmail", () => {
  it("renders the English email with the Home, role, link and expiry, in HTML and plain text", async () => {
    const email = await renderHomeInvitationEmail({ ...base, locale: "en" });
    expect(email.subject).toBe("You're invited to join ⁨De Boomgaard⁩ on Madeora");
    expect(email.html).toContain('lang="en"');
    expect(email.html).toContain("<bdi");
    expect(email.html).toContain("De Boomgaard");
    expect(email.html).toContain(`href="${base.url}"`);
    expect(email.text).toContain("View the invitation");
    expect(email.text).toContain(base.url);
    expect(email.text).toContain("as Member");
    expect(email.text).toContain("sam@madeora.test");
    expect(email.text).toContain(formatExpiry(base.expiresAt, "en", base.timeZone));
    expect(email.text).toContain("approves your request");
  });

  it("renders Dutch with the Dutch role name", async () => {
    const email = await renderHomeInvitationEmail({ ...base, locale: "nl", role: "administrator" });
    expect(email.subject).toContain("Je bent uitgenodigd voor");
    expect(email.html).toContain('lang="nl"');
    expect(email.text).toContain("als Beheerder");
    expect(email.text).toContain("Uitnodiging bekijken");
  });

  it("shows the expiry in the Home's timezone", () => {
    expect(formatExpiry(base.expiresAt, "en", "Europe/Brussels")).toContain("18:00");
    expect(formatExpiry(base.expiresAt, "en", "UTC")).toContain("16:00");
  });

  it("escapes a Home name that looks like HTML", async () => {
    const email = await renderHomeInvitationEmail({
      ...base,
      locale: "en",
      homeName: '<img src=x onerror="alert(1)">',
    });
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("&lt;img");
  });

  it("names no inviter and no other person", async () => {
    const email = await renderHomeInvitationEmail({ ...base, locale: "en" });
    expect(email.text).not.toMatch(/invited you|by [A-Z]/);
  });
});

const outgoing: OutgoingEmail = {
  to: "sam@madeora.test",
  subject: "Subject",
  html: "<p>Hi</p>",
  text: "Hi",
  idempotencyKey: "invitation:1:send:1",
};

function fakeFetch(status: number) {
  return vi.fn<typeof fetch>(() => Promise.resolve(new Response("{}", { status })));
}

describe("createResendTransport", () => {
  it("posts to Resend with the key, sender and idempotency key", async () => {
    const fetchMock = fakeFetch(200);
    const transport = createResendTransport({
      apiKey: "re_test_key",
      from: "Madeora <no-reply@mail.madeora.studio>",
      fetch: fetchMock,
    });
    await expect(transport.send(outgoing)).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.resend.com/emails");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer re_test_key");
    expect(headers["idempotency-key"]).toBe("invitation:1:send:1");
    expect(JSON.parse(init?.body as string)).toEqual({
      from: "Madeora <no-reply@mail.madeora.studio>",
      to: ["sam@madeora.test"],
      subject: "Subject",
      html: "<p>Hi</p>",
      text: "Hi",
    });
  });

  it.each([
    [403, "rejected"],
    [422, "rejected"],
    [409, "unavailable"],
    [429, "unavailable"],
    [500, "unavailable"],
  ] as const)("maps HTTP %i to %s", async (status, reason) => {
    const transport = createResendTransport({
      apiKey: "re_x",
      from: "a@b",
      fetch: fakeFetch(status),
    });
    await expect(transport.send(outgoing)).resolves.toEqual({ ok: false, reason, status });
  });

  it("reports a network failure as unavailable", async () => {
    const transport = createResendTransport({
      apiKey: "re_x",
      from: "a@b",
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    await expect(transport.send(outgoing)).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("createMailpitTransport", () => {
  it("posts to Mailpit's send API with the sender split into name and address", async () => {
    const fetchMock = fakeFetch(200);
    const transport = createMailpitTransport({
      url: "http://127.0.0.1:54324",
      from: "Madeora <no-reply@madeora.test>",
      fetch: fetchMock,
    });
    await expect(transport.send(outgoing)).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:54324/api/v1/send");
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body.From).toEqual({ Email: "no-reply@madeora.test", Name: "Madeora" });
    expect(body.To).toEqual([{ Email: "sam@madeora.test" }]);
    expect(body.Subject).toBe("Subject");
  });

  it("accepts a bare sender address", async () => {
    const fetchMock = fakeFetch(200);
    await createMailpitTransport({
      url: "http://127.0.0.1:1",
      from: "x@madeora.test",
      fetch: fetchMock,
    }).send(outgoing);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(body.From).toEqual({ Email: "x@madeora.test" });
  });
});
