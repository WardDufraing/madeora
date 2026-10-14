import type { Mock } from "vitest";

import { PATCH } from "./route";

interface Identity {
  current: { userId: string } | null;
}
interface Database {
  upsert: Mock<(...args: unknown[]) => void>;
  result: { data: unknown; error: unknown };
}
const identity = vi.hoisted((): Identity => ({ current: { userId: "user-a" } }));
const database = vi.hoisted((): Database => ({
  upsert: vi.fn(),
  result: { data: null, error: null },
}));

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(identity.current),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      from: (table: string) => ({
        upsert: (row: unknown, options: unknown) => {
          database.upsert(table, row, options);
          return {
            select: () => ({ single: () => Promise.resolve(database.result) }),
          };
        },
      }),
    }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const savedRow = {
  display_name: "Sam",
  locale: "nl",
  date_format: null,
  time_format: "24h",
  week_start: null,
  number_format: null,
  measurement_system: null,
  timezone: "Europe/Brussels",
};

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };

function patch(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return PATCH(
    new Request("https://madeora.example/api/v1/me/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...sameOrigin, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  identity.current = { userId: "user-a" };
  database.upsert.mockReset();
  database.result = { data: savedRow, error: null };
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("PATCH /api/v1/me/preferences", () => {
  it("saves the change as the signed-in account and returns every saved preference", async () => {
    const response = await patch({
      displayName: " Sam ",
      locale: "nl",
      timeZone: "europe/brussels",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(database.upsert).toHaveBeenCalledWith(
      "user_preferences",
      { user_id: "user-a", display_name: "Sam", locale: "nl", timezone: "Europe/Brussels" },
      { onConflict: "user_id" },
    );
    expect(await response.json()).toEqual({
      preferences: {
        displayName: "Sam",
        locale: "nl",
        dateFormat: null,
        timeFormat: "24h",
        weekStart: null,
        numberFormat: null,
        measurementSystem: null,
        timeZone: "Europe/Brussels",
      },
    });
  });

  it("writes only the fields in the change, and null to return a setting to Automatic", async () => {
    await patch({ dateFormat: null, timeZone: null });
    expect(database.upsert).toHaveBeenCalledWith(
      "user_preferences",
      { user_id: "user-a", date_format: null, timezone: null },
      { onConflict: "user_id" },
    );
  });

  it.each([
    [{ origin: "https://evil.example" }],
    [{ origin: "null" }],
    [{ origin: "", "sec-fetch-site": "cross-site" }],
  ])("refuses a cross-site request %j (CSRF) without touching the database", async (headers) => {
    const response = await PATCH(
      new Request("https://madeora.example/api/v1/me/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json", host: "madeora.example", ...headers },
        body: JSON.stringify({ locale: "nl" }),
      }),
    );
    expect(response.status).toBe(403);
    expect(database.upsert).not.toHaveBeenCalled();
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", ""])(
    "refuses the content type %j, which a cross-site form could send",
    async (type) => {
      const response = await patch({ locale: "nl" }, { "content-type": type });
      expect(response.status).toBe(415);
      expect(database.upsert).not.toHaveBeenCalled();
    },
  );

  it("refuses a signed-out request", async () => {
    identity.current = null;
    const response = await patch({ locale: "nl" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(database.upsert).not.toHaveBeenCalled();
  });

  it("refuses an oversized body", async () => {
    const response = await patch({ displayName: "a".repeat(5000) });
    expect(response.status).toBe(413);
    expect(database.upsert).not.toHaveBeenCalled();
  });

  it("refuses a declared oversized body before reading it", async () => {
    const response = await patch({ locale: "nl" }, { "content-length": "100000" });
    expect(response.status).toBe(413);
  });

  it.each([
    ["not JSON", "{"],
    ["an empty change", {}],
    ["an unknown field", { userId: "user-b" }],
    ["another account's id", { locale: "nl", user_id: "user-b" }],
    ["an unsupported language", { locale: "fr" }],
    ["a timezone offset", { timeZone: "+02:00" }],
    ["a control character in the name", { displayName: "Sa\u0000m" }],
  ])("refuses %s", async (_, body) => {
    const response = await patch(body);
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({ error: "invalid" });
    expect(database.upsert).not.toHaveBeenCalled();
  });

  it("names the refused fields", async () => {
    const response = await patch({ locale: "fr", weekStart: "friday" });
    expect(await response.json()).toEqual({ error: "invalid", fields: ["locale", "weekStart"] });
  });

  it("treats a value the database refuses (check violation) as invalid input", async () => {
    database.result = { data: null, error: { code: "23514", message: "check violation" } };
    const response = await patch({ displayName: "Sam" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid" });
  });

  it("refuses a malformed Content-Length", async () => {
    const response = await patch({ locale: "nl" }, { "content-length": "abc" });
    expect(response.status).toBe(400);
    expect(database.upsert).not.toHaveBeenCalled();
  });

  it("stops reading a body without Content-Length once it passes the limit", async () => {
    const big = new TextEncoder().encode(JSON.stringify({ displayName: "a".repeat(10_000) }));
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= big.length) {
          controller.close();
          return;
        }
        controller.enqueue(big.slice(pulled, pulled + 1024));
        pulled += 1024;
      },
    });
    const response = await PATCH(
      new Request("https://madeora.example/api/v1/me/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...sameOrigin },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(big.length);
  });

  it("reports a database failure without details, and logs only the error code", async () => {
    database.result = { data: null, error: { code: "42P01", message: "relation does not exist" } };
    const response = await patch({ locale: "nl" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "failed" });
    expect(console.error).toHaveBeenCalledWith(
      JSON.stringify({ event: "preferences.write_failed", code: "42P01" }),
    );
  });
});
