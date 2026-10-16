import type { Mock } from "vitest";

import { GET } from "./route";
import { POST as empty } from "./empty/route";
import { POST as purge } from "./purge/route";
import { POST as restore } from "./restore/route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () => Promise.resolve({ rpc: state.rpc }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const ENTRY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";
const ENTRY_2 = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f02";
const BEFORE = "2026-10-15T12:00:00.000Z";
const HOME = "0b6f6c55-3a4e-4f7a-9f15-9a8a1d0c0001";

function post(
  handler: (request: Request) => Promise<Response>,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return handler(
    new Request("https://madeora.example/api/v1/trash/x", {
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

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /api/v1/trash", () => {
  const get = (query = "") => GET(new Request(`https://madeora.example/api/v1/trash${query}`));

  it("lists the person's entries from the database, never cached", async () => {
    state.rpc.mockResolvedValue({
      data: [
        {
          entry_id: ENTRY,
          module: "sample",
          item_type: "sample",
          label: "Sample",
          deleted_at: "2026-10-15T10:00:00Z",
          expires_at: "2026-10-22T10:00:00Z",
          deleted_by_me: true,
          file_count: 1,
        },
        {
          entry_id: ENTRY_2,
          module: "future",
          item_type: "other",
          label: "x",
          deleted_at: "",
          expires_at: "",
          deleted_by_me: false,
          file_count: 0,
        },
      ],
      error: null,
    });
    const response = await get(`?homeId=${HOME}&module=sample&deletedFrom=2026-10-01T00:00:00Z`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      entries: [
        {
          id: ENTRY,
          module: "sample",
          itemType: "sample",
          label: "Sample",
          deletedAt: "2026-10-15T10:00:00Z",
          expiresAt: "2026-10-22T10:00:00Z",
          deletedByMe: true,
          fileCount: 1,
        },
      ],
    });
    expect(state.rpc).toHaveBeenCalledWith("list_trash", {
      p_home_id: HOME,
      p_module: "sample",
      p_deleted_from: "2026-10-01T00:00:00Z",
    });
  });

  it("refuses signed-out callers and malformed or unknown filters", async () => {
    state.identity = null;
    expect((await get()).status).toBe(401);
    state.identity = { userId: "user-a" };
    expect((await get("?homeId=nope")).status).toBe(400);
    expect((await get("?module=unknown")).status).toBe(400);
    expect((await get("?surprise=1")).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 404 for a Home the person is not in, 500 for a failure, and logs no ids", async () => {
    state.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "42501", message: "not permitted" },
    });
    expect((await get(`?homeId=${HOME}`)).status).toBe(404);
    state.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "XX000", message: `boom ${ENTRY}` },
    });
    expect((await get()).status).toBe(500);
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).not.toContain(ENTRY);
  });
});

describe("POST /api/v1/trash/restore", () => {
  it("restores each entry on its own and reports every outcome", async () => {
    state.rpc.mockResolvedValue({
      data: [
        {
          entry_id: ENTRY,
          outcome: "restored",
          conflict: null,
          options: null,
          attachments_lost: 1,
        },
        {
          entry_id: ENTRY_2,
          outcome: "needs_resolution",
          conflict: "slot_taken",
          options: ["clear_slot", "bogus"],
          attachments_lost: 0,
        },
      ],
      error: null,
    });
    const response = await post(restore, {
      entryIds: [ENTRY, ENTRY_2],
      resolutions: { [ENTRY_2]: "clear_slot" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [
        { entryId: ENTRY, outcome: "restored", conflict: null, options: [], attachmentsLost: 1 },
        {
          entryId: ENTRY_2,
          outcome: "needs_resolution",
          conflict: "slot_taken",
          options: ["clear_slot"],
          attachmentsLost: 0,
        },
      ],
    });
    expect(state.rpc).toHaveBeenCalledWith("restore_trash_entries", {
      p_entry_ids: [ENTRY, ENTRY_2],
      p_resolutions: { [ENTRY_2]: "clear_slot" },
    });
  });

  it("refuses cross-site, non-JSON, signed-out, malformed and oversized requests", async () => {
    const valid = { entryIds: [ENTRY] };
    expect((await post(restore, valid, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(restore, valid, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(restore, "{nope")).status).toBe(400);
    expect((await post(restore, { entryIds: [] })).status).toBe(400);
    expect((await post(restore, { entryIds: ["x"] })).status).toBe(400);
    expect((await post(restore, { entryIds: [ENTRY], extra: 1 })).status).toBe(400);
    expect(
      (await post(restore, { entryIds: Array.from({ length: 101 }, () => ENTRY) })).status,
    ).toBe(400);
    expect(
      (await post(restore, { entryIds: [ENTRY], resolutions: { [ENTRY]: "overwrite" } })).status,
    ).toBe(400);
    state.identity = null;
    expect((await post(restore, valid)).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("maps a database refusal to a whole-request error", async () => {
    state.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "22023", message: "invalid request" },
    });
    expect((await post(restore, { entryIds: [ENTRY] })).status).toBe(400);
    state.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "42501", message: "not signed in" },
    });
    expect((await post(restore, { entryIds: [ENTRY] })).status).toBe(401);
    state.rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "boom" } });
    expect((await post(restore, { entryIds: [ENTRY] })).status).toBe(500);
  });
});

describe("POST /api/v1/trash/purge", () => {
  it("needs the explicit confirmation before it asks the database anything", async () => {
    expect((await post(purge, { entryIds: [ENTRY] })).status).toBe(400);
    expect((await post(purge, { entryIds: [ENTRY], confirm: false })).status).toBe(400);
    expect((await post(purge, { entryIds: [ENTRY], confirm: "yes" })).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("deletes permanently and reports entries it could not touch as not found", async () => {
    state.rpc.mockResolvedValue({
      data: [
        { entry_id: ENTRY, outcome: "purged" },
        { entry_id: ENTRY_2, outcome: "not_found" },
        { entry_id: HOME, outcome: "something-else" },
      ],
      error: null,
    });
    const response = await post(purge, { entryIds: [ENTRY, ENTRY_2], confirm: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [
        { entryId: ENTRY, outcome: "purged" },
        { entryId: ENTRY_2, outcome: "not_found" },
        { entryId: HOME, outcome: "failed" },
      ],
    });
    expect(state.rpc).toHaveBeenCalledWith("purge_trash_entries", {
      p_entry_ids: [ENTRY, ENTRY_2],
    });
  });
});

describe("POST /api/v1/trash/empty", () => {
  it("needs the confirmation, then empties the personal or a Home trash", async () => {
    expect((await post(empty, {})).status).toBe(400);
    expect((await post(empty, { confirm: true })).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
    state.rpc.mockResolvedValue({ data: [{ entry_id: ENTRY, outcome: "purged" }], error: null });
    expect((await post(empty, { confirm: true, deletedBefore: BEFORE })).status).toBe(200);
    expect(state.rpc).toHaveBeenLastCalledWith("empty_trash", { p_deleted_before: BEFORE });
    expect((await post(empty, { homeId: HOME, deletedBefore: BEFORE, confirm: true })).status).toBe(
      200,
    );
    expect(state.rpc).toHaveBeenLastCalledWith("empty_trash", {
      p_home_id: HOME,
      p_deleted_before: BEFORE,
    });
  });

  it("answers 404 for a Home the person is not in", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "not permitted" } });
    expect((await post(empty, { homeId: HOME, deletedBefore: BEFORE, confirm: true })).status).toBe(
      404,
    );
  });
});
