// S35: the photo routes. The database decides every right (tests/db/rls/photos.test.sql); these
// tests check what the routes send it, how they answer, and that every refusal looks the same as
// "does not exist".
import type { Mock } from "vitest";

import {
  DELETE as removeFromAlbum,
  POST as addToAlbum,
} from "../photo-albums/[albumId]/photos/route";
import { DELETE as deleteAlbum, PATCH as renameAlbum } from "../photo-albums/[albumId]/route";
import { POST as createAlbum } from "../photo-albums/route";
import { GET as content } from "./[photoId]/content/route";
import { POST as deletePhotos } from "./delete/route";
import { GET as library } from "./route";
import { POST as intent } from "./upload-intents/route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
  storage: boolean;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  rpc: vi.fn(),
  storage: true,
}));

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args: Record<string, unknown>) => Promise.resolve(state.rpc(name, args)),
    }),
}));
vi.mock("@/storage/server", () => ({
  getStorage: () =>
    state.storage
      ? {
          objects: {
            presignPut: (key: string) => ({
              url: `https://storage.example/${key}`,
              headers: { "content-type": "image/heic" },
            }),
            presignGet: (key: string) => `https://storage.example/get/${key}`,
          },
        }
      : null,
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const HOME = "33333333-3333-4333-8333-333333333333";
const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };
const crossSite = { origin: "https://evil.example", host: "madeora.example" };

function request(path: string, method: string, body?: unknown, headers = sameOrigin): Request {
  return new Request(`https://madeora.example/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const albumParams = { params: Promise.resolve({ albumId: ID }) };
const photoParams = { params: Promise.resolve({ photoId: ID }) };

function answers(outcomes: Record<string, unknown>) {
  state.rpc.mockImplementation((name) =>
    name in outcomes
      ? { data: outcomes[name], error: null }
      : { data: null, error: { code: "XX000", message: "unexpected" } },
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.storage = true;
  state.rpc.mockReset();
});

const intentBody = {
  owner: { scope: "personal" },
  contentType: "image/heic",
  size: 4_000_000,
  requestId: ID,
};

describe("checks every request makes", () => {
  it("refuses a cross-site change and a signed-out person before the database", async () => {
    expect(
      (await intent(request("/photos/upload-intents", "POST", intentBody, crossSite))).status,
    ).toBe(403);
    expect(
      (await deletePhotos(request("/photos/delete", "POST", { photoIds: [ID] }, crossSite))).status,
    ).toBe(403);
    state.identity = null;
    expect((await intent(request("/photos/upload-intents", "POST", intentBody))).status).toBe(401);
    expect(
      (
        await createAlbum(
          request("/photo-albums", "POST", { id: ID, owner: { scope: "personal" }, name: "x" }),
        )
      ).status,
    ).toBe(401);
    expect((await library(request("/photos?scope=personal", "GET"))).status).toBe(401);
    expect(
      (await content(request(`/photos/${ID}/content?variant=thumb`, "GET"), photoParams)).status,
    ).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses invalid input before the database", async () => {
    const bad = (body: unknown) => intent(request("/photos/upload-intents", "POST", body));
    expect((await bad({ ...intentBody, contentType: "application/pdf" })).status).toBe(400);
    expect((await bad({ ...intentBody, size: 25 * 1024 * 1024 + 1 })).status).toBe(400);
    expect((await bad({ ...intentBody, size: 0 })).status).toBe(400);
    expect((await bad({ ...intentBody, owner: { scope: "home" } })).status).toBe(400);
    expect((await bad({ ...intentBody, extra: true })).status).toBe(400);
    expect((await deletePhotos(request("/photos/delete", "POST", { photoIds: [] }))).status).toBe(
      400,
    );
    expect(
      (await deletePhotos(request("/photos/delete", "POST", { photoIds: ["nope"] }))).status,
    ).toBe(400);
    expect(
      (
        await createAlbum(
          request("/photo-albums", "POST", { id: ID, owner: { scope: "personal" }, name: "   " }),
        )
      ).status,
    ).toBe(400);
    expect((await library(request("/photos?scope=home", "GET"))).status).toBe(400);
    expect((await library(request(`/photos?scope=personal&homeId=${HOME}`, "GET"))).status).toBe(
      400,
    );
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers a malformed id as not found without asking the database", async () => {
    const bad = { params: Promise.resolve({ albumId: "nope" }) };
    expect(
      (
        await renameAlbum(
          request("/photo-albums/nope", "PATCH", { name: "A", expectedRevision: 1 }),
          bad,
        )
      ).status,
    ).toBe(404);
    expect(
      (await addToAlbum(request("/photo-albums/nope/photos", "POST", { photoIds: [ID] }), bad))
        .status,
    ).toBe(404);
    const badPhoto = { params: Promise.resolve({ photoId: "nope" }) };
    expect(
      (await content(request("/photos/nope/content?variant=thumb", "GET"), badPhoto)).status,
    ).toBe(404);
    expect(
      (await content(request(`/photos/${ID}/content?variant=huge`, "GET"), photoParams)).status,
    ).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("upload intents", () => {
  const rows = (outcome: string) => ({
    create_photo_intent: [
      outcome === "ok"
        ? {
            outcome,
            file_id: ID,
            upload_key: "u/" + "a".repeat(64),
            expires_at: "2026-11-05T16:00:00Z",
          }
        : { outcome, file_id: null, upload_key: null, expires_at: null },
    ],
  });

  it("opens a personal upload and signs a link without exposing a key choice", async () => {
    answers(rows("ok"));
    const response = await intent(request("/photos/upload-intents", "POST", intentBody));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { fileId: string; uploadUrl: string };
    expect(body.fileId).toBe(ID);
    expect(body.uploadUrl).toContain("https://storage.example/u/");
    expect(state.rpc).toHaveBeenCalledWith("create_photo_intent", {
      p_home_id: null,
      p_content_type: "image/heic",
      p_size: 4_000_000,
      p_request_id: ID,
    });
  });

  it("names the Home for a Home library", async () => {
    answers(rows("ok"));
    await intent(
      request("/photos/upload-intents", "POST", {
        ...intentBody,
        owner: { scope: "home", homeId: HOME },
      }),
    );
    expect(state.rpc).toHaveBeenCalledWith(
      "create_photo_intent",
      expect.objectContaining({ p_home_id: HOME }),
    );
  });

  it.each([
    ["not_permitted", 403, "not-permitted"],
    ["storage_full", 409, "storage-full"],
    ["rate_limited", 429, "rate-limited"],
    ["conflict", 409, "conflict"],
  ])("maps %s", async (outcome, status, code) => {
    answers(rows(outcome));
    const response = await intent(request("/photos/upload-intents", "POST", intentBody));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  });

  it("answers 503 where storage is off, without asking the database", async () => {
    state.storage = false;
    expect((await intent(request("/photos/upload-intents", "POST", intentBody))).status).toBe(503);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("the library", () => {
  const page = {
    homeId: null,
    canUpload: true,
    canManage: true,
    albumId: null,
    albumName: null,
    total: 0,
    photos: [],
    albums: [],
  };

  it("answers a page, and 404 for a library the person may not see", async () => {
    answers({ list_photo_library: page });
    const ok = await library(request("/photos?scope=personal", "GET"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ library: page });
    answers({ list_photo_library: null });
    expect((await library(request(`/photos?scope=home&homeId=${HOME}`, "GET"))).status).toBe(404);
  });

  it("treats a database answer of the wrong shape as a failure, not a page", async () => {
    answers({ list_photo_library: { photos: "x" } });
    expect((await library(request("/photos?scope=personal", "GET"))).status).toBe(500);
  });
});

describe("content", () => {
  it("redirects to a short-lived link after the database authorizes the viewer", async () => {
    answers({
      authorize_photo_read: [{ object_key: "u/" + "b".repeat(64), content_type: "image/webp" }],
    });
    const response = await content(
      request(`/photos/${ID}/content?variant=thumb`, "GET"),
      photoParams,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("https://storage.example/get/");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(state.rpc).toHaveBeenCalledWith("authorize_photo_read", {
      p_photo_id: ID,
      p_variant: "thumb",
    });
  });

  it("answers 404 for a photo the viewer may not see, like one that does not exist", async () => {
    answers({ authorize_photo_read: [] });
    const response = await content(
      request(`/photos/${ID}/content?variant=master`, "GET"),
      photoParams,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("deleting photos", () => {
  it("sends the ids and reports what was skipped without naming it", async () => {
    answers({ delete_photos: { deleted: 1, skipped: 1 } });
    const response = await deletePhotos(request("/photos/delete", "POST", { photoIds: [ID, ID2] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 1, skipped: 1 });
    expect(state.rpc).toHaveBeenCalledWith("delete_photos", { p_photo_ids: [ID, ID2] });
  });
});

describe("albums", () => {
  const create = { id: ID, owner: { scope: "home", homeId: HOME }, name: "  Zomer  " };

  it("creates (tidied name), answers a retry, and maps refusals", async () => {
    answers({ create_photo_album: { outcome: "created" } });
    expect((await createAlbum(request("/photo-albums", "POST", create))).status).toBe(201);
    expect(state.rpc).toHaveBeenCalledWith("create_photo_album", {
      p_id: ID,
      p_home_id: HOME,
      p_name: "Zomer",
    });
    answers({ create_photo_album: { outcome: "exists" } });
    expect((await createAlbum(request("/photo-albums", "POST", create))).status).toBe(200);
    answers({ create_photo_album: { outcome: "not_permitted" } });
    expect((await createAlbum(request("/photo-albums", "POST", create))).status).toBe(403);
    answers({ create_photo_album: { outcome: "limit" } });
    expect((await createAlbum(request("/photo-albums", "POST", create))).status).toBe(409);
  });

  it("renames and deletes with the revision, and maps a stale one to a conflict", async () => {
    answers({ rename_photo_album: { outcome: "saved", revision: 3 } });
    const renamed = await renameAlbum(
      request(`/photo-albums/${ID}`, "PATCH", { name: "Winter", expectedRevision: 2 }),
      albumParams,
    );
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ revision: 3 });
    answers({ rename_photo_album: { outcome: "stale", revision: 5 } });
    expect(
      (
        await renameAlbum(
          request(`/photo-albums/${ID}`, "PATCH", { name: "W", expectedRevision: 2 }),
          albumParams,
        )
      ).status,
    ).toBe(409);
    answers({ delete_photo_album: { outcome: "deleted" } });
    expect(
      (
        await deleteAlbum(
          request(`/photo-albums/${ID}`, "DELETE", { expectedRevision: 3 }),
          albumParams,
        )
      ).status,
    ).toBe(200);
    answers({ delete_photo_album: { outcome: "not_found" } });
    expect(
      (
        await deleteAlbum(
          request(`/photo-albums/${ID}`, "DELETE", { expectedRevision: 3 }),
          albumParams,
        )
      ).status,
    ).toBe(404);
    answers({ rename_photo_album: { outcome: "not_permitted" } });
    expect(
      (
        await renameAlbum(
          request(`/photo-albums/${ID}`, "PATCH", { name: "W", expectedRevision: 2 }),
          albumParams,
        )
      ).status,
    ).toBe(403);
  });

  it("adds photos and takes them out without deleting them", async () => {
    answers({ add_photos_to_album: { outcome: "saved", added: 2, skipped: 0 } });
    const added = await addToAlbum(
      request(`/photo-albums/${ID}/photos`, "POST", { photoIds: [ID, ID2] }),
      albumParams,
    );
    expect(await added.json()).toEqual({ added: 2, removed: 0 });
    answers({ remove_photos_from_album: { outcome: "saved", removed: 1 } });
    const removed = await removeFromAlbum(
      request(`/photo-albums/${ID}/photos`, "DELETE", { photoIds: [ID] }),
      albumParams,
    );
    expect(await removed.json()).toEqual({ added: 0, removed: 1 });
    expect(state.rpc).not.toHaveBeenCalledWith("delete_photos", expect.anything());
    answers({ add_photos_to_album: { outcome: "limit" } });
    expect(
      (
        await addToAlbum(
          request(`/photo-albums/${ID}/photos`, "POST", { photoIds: [ID] }),
          albumParams,
        )
      ).status,
    ).toBe(409);
    answers({ add_photos_to_album: { outcome: "not_found" } });
    expect(
      (
        await addToAlbum(
          request(`/photo-albums/${ID}/photos`, "POST", { photoIds: [ID] }),
          albumParams,
        )
      ).status,
    ).toBe(404);
  });
});
