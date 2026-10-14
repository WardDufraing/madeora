import type { Mock } from "vitest";

import { POST } from "./route";

interface Identity {
  current: { userId: string } | null;
}
interface Database {
  rpc: Mock<(...args: unknown[]) => void>;
  result: { data: unknown; error: unknown };
}
const identity = vi.hoisted((): Identity => ({ current: { userId: "user-a" } }));
const database = vi.hoisted((): Database => ({
  rpc: vi.fn(),
  result: { data: null, error: null },
}));

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(identity.current),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args: unknown) => {
        database.rpc(name, args);
        return Promise.resolve(database.result);
      },
    }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const REQUEST_ID = "0b7d6f5e-4c3b-4a29-8e1f-0a9b8c7d6e5f";
const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request("https://madeora.example/api/v1/homes", {
      method: "POST",
      headers: { "content-type": "application/json", ...sameOrigin, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const valid = { name: " Thuis ", timeZone: "europe/brussels", requestId: REQUEST_ID };

beforeEach(() => {
  identity.current = { userId: "user-a" };
  database.rpc.mockReset();
  database.result = { data: HOME_ID, error: null };
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/homes", () => {
  it("creates the Home through create_home with the normalized values", async () => {
    const response = await post(valid);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ home: { id: HOME_ID } });
    expect(database.rpc).toHaveBeenCalledWith("create_home", {
      p_name: "Thuis",
      p_timezone: "Europe/Brussels",
      p_request_id: REQUEST_ID,
    });
  });

  it.each([
    [{ origin: "https://evil.example" }],
    [{ origin: "null" }],
    [{ origin: "", "sec-fetch-site": "cross-site" }],
  ])("refuses a cross-site request %j (CSRF)", async (headers) => {
    const response = await POST(
      new Request("https://madeora.example/api/v1/homes", {
        method: "POST",
        headers: { "content-type": "application/json", host: "madeora.example", ...headers },
        body: JSON.stringify(valid),
      }),
    );
    expect(response.status).toBe(403);
    expect(database.rpc).not.toHaveBeenCalled();
  });

  it("refuses a form post (only JSON is accepted)", async () => {
    const response = await post(valid, { "content-type": "application/x-www-form-urlencoded" });
    expect(response.status).toBe(415);
    expect(database.rpc).not.toHaveBeenCalled();
  });

  it("refuses a signed-out request", async () => {
    identity.current = null;
    const response = await post(valid);
    expect(response.status).toBe(401);
    expect(database.rpc).not.toHaveBeenCalled();
  });

  it("refuses an oversized body", async () => {
    const response = await post({ ...valid, name: "a".repeat(3000) });
    expect(response.status).toBe(413);
    expect(database.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "{"],
    ["no request id", { name: "Thuis", timeZone: "UTC" }],
    ["an invisible name", { ...valid, name: "\u{200B}" }],
    ["an unknown timezone", { ...valid, timeZone: "Mars/Olympus" }],
    ["an owner chosen by the caller", { ...valid, ownerId: "user-b" }],
  ])("refuses %s", async (_, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(database.rpc).not.toHaveBeenCalled();
  });

  it("names the refused fields", async () => {
    const response = await post({ ...valid, name: "", timeZone: "x" });
    expect(await response.json()).toEqual({ error: "invalid", fields: ["name", "timeZone"] });
  });

  it("treats a value the database refuses as invalid input", async () => {
    database.result = { data: null, error: { code: "23514", message: "check" } };
    expect((await post(valid)).status).toBe(400);
  });

  it("treats a session the database does not accept as signed out", async () => {
    database.result = { data: null, error: { code: "42501", message: "not signed in" } };
    expect((await post(valid)).status).toBe(401);
  });

  it("logs only the error code when the database fails", async () => {
    database.result = { data: null, error: { code: "08006", message: "connection lost" } };
    const response = await post(valid);
    expect(response.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(
      JSON.stringify({ event: "homes.create_failed", code: "08006" }),
    );
  });
});
