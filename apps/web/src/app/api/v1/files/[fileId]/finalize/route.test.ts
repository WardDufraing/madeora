import { StorageUnavailableError } from "@madeora/storage";
import type { Mock } from "vitest";

import { POST } from "./route";

type Rpc = (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>;
type AnyFn = (...args: never[]) => unknown;
interface Objects {
  head: Mock<AnyFn>;
  get: Mock<AnyFn>;
  put: Mock<AnyFn>;
  delete: Mock<AnyFn>;
}
interface State {
  identity: { userId: string } | null;
  rpc: Mock<Rpc>;
  objects: Objects;
  finalize: Mock;
  storageOn: boolean;
  process: Mock;
  claim: string;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  rpc: vi.fn(),
  objects: { head: vi.fn(), get: vi.fn(), put: vi.fn(), delete: vi.fn() },
  finalize: vi.fn(),
  storageOn: true,
  process: vi.fn(),
  claim: "claimed",
}));

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () => Promise.resolve({ rpc: state.rpc }),
}));
vi.mock("@/storage/server", () => ({
  getStorage: () =>
    state.storageOn ? { objects: state.objects, finalizer: { finalize: state.finalize } } : null,
}));
vi.mock("@/storage/avatar-image", () => ({ processAvatar: state.process }));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const FILE_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";
const UPLOAD_KEY = `u/${"a".repeat(64)}`;
const OBJECT_KEY = `u/${"b".repeat(64)}`;
const BYTES = new Uint8Array(2048);
const PROCESSED = new Uint8Array([1, 2, 3]);

function upload(extra: Record<string, unknown> = {}) {
  return {
    status: "pending",
    purpose: "avatar",
    declared_type: "image/png",
    declared_size: 2048,
    upload_key: UPLOAD_KEY,
    object_key: OBJECT_KEY,
    ...extra,
  };
}

function finalize(fileId = FILE_ID, body: unknown = {}) {
  return POST(
    new Request(`https://madeora.example/api/v1/files/${fileId}/finalize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://madeora.example",
        host: "madeora.example",
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ fileId }) },
  );
}

function withUpload(row: Record<string, unknown> | null) {
  state.rpc.mockImplementation((name) => {
    if (name === "get_my_upload") return Promise.resolve({ data: row ? [row] : [], error: null });
    if (name === "claim_my_upload") return Promise.resolve({ data: state.claim, error: null });
    return Promise.resolve({ data: true, error: null });
  });
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.storageOn = true;
  state.claim = "claimed";
  state.rpc.mockReset();
  const { head, get, put, delete: remove } = state.objects;
  for (const mock of [head, get, put, remove]) mock.mockReset();
  state.objects.head.mockResolvedValue({ size: 2048, contentType: "image/png" });
  state.objects.get.mockResolvedValue({ status: "ok", bytes: BYTES });
  state.objects.put.mockResolvedValue(undefined);
  state.objects.delete.mockResolvedValue(undefined);
  state.finalize.mockReset().mockResolvedValue("ready");
  state.process.mockReset().mockResolvedValue({
    ok: true,
    bytes: PROCESSED,
    contentType: "image/webp",
    sha256: "c".repeat(64),
  });
  withUpload(upload());
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/files/{fileId}/finalize", () => {
  it("reads the real bytes, stores the processed picture and finalizes with the verified facts", async () => {
    const response = await finalize();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ file: { id: FILE_ID } });
    expect(state.rpc).toHaveBeenCalledWith("get_my_upload", { p_file_id: FILE_ID });
    expect(state.rpc).toHaveBeenCalledWith("claim_my_upload", { p_file_id: FILE_ID });
    expect(state.objects.get).toHaveBeenCalledWith(UPLOAD_KEY, 2048);
    expect(state.process).toHaveBeenCalledWith(BYTES, "image/png");
    expect(state.objects.put).toHaveBeenCalledWith(OBJECT_KEY, PROCESSED, "image/webp");
    // The identity is the verified session's, never something the request names.
    expect(state.finalize).toHaveBeenCalledWith("user-a", FILE_ID, {
      contentType: "image/webp",
      size: 3,
      sha256: "c".repeat(64),
    });
    // The raw upload is not kept.
    expect(state.objects.delete).toHaveBeenCalledWith(UPLOAD_KEY);
    expect(state.objects.delete).not.toHaveBeenCalledWith(OBJECT_KEY);
  });

  it("answers an already finished upload again without touching storage", async () => {
    withUpload(upload({ status: "ready" }));
    const response = await finalize();
    expect(response.status).toBe(200);
    expect(state.objects.head).not.toHaveBeenCalled();
    expect(state.finalize).not.toHaveBeenCalled();
  });

  it("answers 404 for an upload that is not the caller's (the database returns nothing)", async () => {
    withUpload(null);
    const response = await finalize();
    expect(response.status).toBe(404);
    expect(state.objects.head).not.toHaveBeenCalled();
  });

  it("answers 404 for a forged, malformed file id without asking the database", async () => {
    const response = await finalize("../../h/abc");
    expect(response.status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses an expired upload", async () => {
    withUpload(upload({ status: "expired" }));
    const response = await finalize();
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "expired" });
  });

  it.each(["failed", "deleted", "purged"])("treats a %s upload as gone", async (status) => {
    withUpload(upload({ status }));
    expect((await finalize()).status).toBe(404);
  });

  it("says the bytes are not there yet, without giving up the upload", async () => {
    state.objects.head.mockResolvedValue(null);
    const response = await finalize();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "not-uploaded" });
    expect(state.rpc).not.toHaveBeenCalledWith("abandon_my_upload", expect.anything());
    // The claim is given back so the next attempt can run.
    expect(state.rpc).toHaveBeenCalledWith("release_my_upload", { p_file_id: FILE_ID });
  });

  it.each([
    ["a different size", { size: 4096, contentType: "image/png" }],
    ["a different type", { size: 2048, contentType: "text/html" }],
  ])("abandons an upload stored with %s than declared and deletes it", async (_label, facts) => {
    state.objects.head.mockResolvedValue(facts);
    const response = await finalize();
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "mismatch" });
    expect(state.rpc).toHaveBeenCalledWith("abandon_my_upload", {
      p_file_id: FILE_ID,
      p_reason: "mismatch",
    });
    expect(state.objects.delete).toHaveBeenCalledWith(UPLOAD_KEY);
    expect(state.objects.delete).toHaveBeenCalledWith(OBJECT_KEY);
    expect(state.process).not.toHaveBeenCalled();
    expect(state.finalize).not.toHaveBeenCalled();
  });

  it("abandons an upload whose body is larger than declared", async () => {
    state.objects.get.mockResolvedValue({ status: "too-large" });
    const response = await finalize();
    expect(response.status).toBe(422);
    expect(state.finalize).not.toHaveBeenCalled();
  });

  it.each(["mismatch", "invalid-image"] as const)(
    "abandons a file the image check calls %s",
    async (reason) => {
      state.process.mockResolvedValue({ ok: false, reason });
      const response = await finalize();
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: reason });
      expect(state.objects.put).not.toHaveBeenCalled();
      expect(state.finalize).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["busy", 409, "conflict"],
    ["limit", 429, "rate-limited"],
    ["expired", 410, "expired"],
    ["not_found", 404, "not-found"],
  ])(
    "does no storage work when the upload cannot be claimed (%s)",
    async (claim, status, error) => {
      state.claim = claim;
      const response = await finalize();
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      expect(state.objects.head).not.toHaveBeenCalled();
      expect(state.process).not.toHaveBeenCalled();
    },
  );

  it("answers a claim that finds the upload already finished with success", async () => {
    state.claim = "ready";
    expect((await finalize()).status).toBe(200);
    expect(state.objects.head).not.toHaveBeenCalled();
  });

  it("never removes the processed object when the database no longer knows the upload", async () => {
    state.finalize.mockResolvedValue("not_found");
    expect((await finalize()).status).toBe(404);
    // Whatever happened to it (finished elsewhere, or failed and queued), it is not ours to remove.
    expect(state.objects.delete).not.toHaveBeenCalled();
  });

  it.each([
    ["storage_full", 409, "storage-full"],
    ["expired", 410, "expired"],
    ["invalid", 500, "failed"],
  ])("removes both objects when the database refuses with %s", async (outcome, status, error) => {
    state.finalize.mockResolvedValue(outcome);
    const response = await finalize();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(state.objects.delete).toHaveBeenCalledWith(UPLOAD_KEY);
    expect(state.objects.delete).toHaveBeenCalledWith(OBJECT_KEY);
  });

  it("answers 503 when storage cannot be reached, logging only a short code", async () => {
    state.objects.head.mockRejectedValue(new StorageUnavailableError("network"));
    const response = await finalize();
    expect(response.status).toBe(503);
    expect(state.rpc).toHaveBeenCalledWith("release_my_upload", { p_file_id: FILE_ID });
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain(UPLOAD_KEY);
  });

  it("still succeeds when removing the raw upload fails (the clean-up job removes it)", async () => {
    state.objects.delete.mockRejectedValue(new Error("down"));
    const response = await finalize();
    expect(response.status).toBe(200);
  });

  it("takes no input: a body naming a user or key is refused", async () => {
    expect((await finalize(FILE_ID, { userId: "user-b" })).status).toBe(400);
    // A body this long is over the 64-byte limit before it is even parsed.
    expect((await finalize(FILE_ID, { key: OBJECT_KEY })).status).toBe(413);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a signed-out request and answers 503 where storage is off", async () => {
    state.identity = null;
    expect((await finalize()).status).toBe(401);
    state.identity = { userId: "user-a" };
    state.storageOn = false;
    expect((await finalize()).status).toBe(503);
  });
});
