import type { Mock } from "vitest";

import { POST } from "./route";

interface State {
  identity: { userId: string } | null;
  storage: { objects: { presignPut: Mock } } | null;
  rpc: Mock<(name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>>;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  storage: null,
  rpc: vi.fn(),
}));

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () => Promise.resolve({ rpc: state.rpc }),
}));
vi.mock("@/storage/server", () => ({ getStorage: () => state.storage }));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const FILE_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";
const REQUEST_ID = "0b6f6c55-3a4e-4f7a-9f15-9a8a1d0c0001";
const KEY = `u/${"a".repeat(64)}`;
const valid = { purpose: "avatar", contentType: "image/png", size: 2048, requestId: REQUEST_ID };

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("https://madeora.example/api/v1/files/upload-intents", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://madeora.example",
        host: "madeora.example",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function intentRow(outcome: string, extra: Record<string, unknown> = {}) {
  return {
    data: [{ outcome, file_id: null, upload_key: null, expires_at: null, ...extra }],
    error: null,
  };
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.storage = {
    objects: {
      presignPut: vi.fn(() => ({
        url: "https://store.example/bucket/key?X-Amz-Signature=sig",
        headers: { "content-type": "image/png" },
      })),
    },
  };
  state.rpc.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/files/upload-intents", () => {
  it("opens an upload in the database and signs a 5-minute link bound to its key, type and size", async () => {
    state.rpc.mockResolvedValue(
      intentRow("ok", {
        file_id: FILE_ID,
        upload_key: KEY,
        expires_at: "2026-10-15T12:15:00Z",
      }),
    );
    const response = await post(valid);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      fileId: FILE_ID,
      uploadUrl: "https://store.example/bucket/key?X-Amz-Signature=sig",
      headers: { "content-type": "image/png" },
      expiresAt: "2026-10-15T12:15:00Z",
    });
    expect(state.rpc).toHaveBeenCalledWith("create_upload_intent", {
      p_purpose: "avatar",
      p_content_type: "image/png",
      p_size: 2048,
      p_request_id: REQUEST_ID,
    });
    expect(state.storage?.objects.presignPut).toHaveBeenCalledWith(KEY, {
      contentType: "image/png",
      contentLength: 2048,
      expiresInSeconds: 300,
    });
  });

  it.each([
    ["storage_full", 409, "storage-full"],
    ["rate_limited", 429, "rate-limited"],
    ["conflict", 409, "conflict"],
    ["surprise", 500, "failed"],
  ])(
    "answers the database outcome %s with %i %s and signs nothing",
    async (outcome, status, error) => {
      state.rpc.mockResolvedValue(intentRow(outcome));
      const response = await post(valid);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      expect(state.storage?.objects.presignPut).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ ...valid, contentType: "image/svg+xml" }],
    [{ ...valid, contentType: "text/html" }],
    [{ ...valid, size: 0 }],
    [{ ...valid, size: 5 * 1024 * 1024 + 1 }],
    [{ ...valid, size: 1.5 }],
    [{ ...valid, purpose: "document" }],
    [{ ...valid, requestId: "not-a-uuid" }],
    // The browser never chooses where the bytes go.
    [{ ...valid, key: KEY }],
    [{ ...valid, bucket: "other" }],
  ])("refuses a request outside the upload policy: %j", async (body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request before anything else", async () => {
    const response = await post(valid, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a signed-out request", async () => {
    state.identity = null;
    const response = await post(valid);
    expect(response.status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("says storage is unavailable where it is not set up", async () => {
    state.storage = null;
    const response = await post(valid);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "storage-unavailable" });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("logs a database failure by code only and answers 500", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "secret detail" } });
    const response = await post(valid);
    expect(response.status).toBe(500);
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain("XX000");
    expect(logged).not.toContain("secret detail");
  });
});
