// S36: the album sharing, deletion impact and photo widget routes. The database decides every right
// (tests/db/rls/photo-sharing.test.sql); these tests check what the routes send it, how they
// answer, and that refusals look the same as "does not exist".
import type { Mock } from "vitest";

import { DELETE as unshare, POST as share } from "../photo-albums/[albumId]/shares/route";
import { POST as impact } from "./deletion-impact/route";
import { GET as widget } from "./widget/route";

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

describe("sharing an album", () => {
  it("sends each Home with its access and answers the share count", async () => {
    answers({ share_photo_album: { outcome: "saved", shareCount: 2 } });
    const response = await share(
      request(`/photo-albums/${ID}/shares`, "POST", {
        shares: [
          { homeId: HOME, access: "contribute" },
          { homeId: ID2, access: "view" },
        ],
      }),
      albumParams,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ shareCount: 2 });
    expect(state.rpc).toHaveBeenCalledWith("share_photo_album", {
      p_album_id: ID,
      p_shares: [
        { homeId: HOME, access: "contribute" },
        { homeId: ID2, access: "view" },
      ],
    });
  });

  it("refuses a duplicate Home, an unknown access, a cross-site or signed-out request first", async () => {
    const twice = {
      shares: [
        { homeId: HOME, access: "view" },
        { homeId: HOME, access: "view" },
      ],
    };
    expect(
      (await share(request(`/photo-albums/${ID}/shares`, "POST", twice), albumParams)).status,
    ).toBe(400);
    const edit = { shares: [{ homeId: HOME, access: "edit" }] };
    expect(
      (await share(request(`/photo-albums/${ID}/shares`, "POST", edit), albumParams)).status,
    ).toBe(400);
    const body = { shares: [{ homeId: HOME, access: "view" }] };
    expect(
      (await share(request(`/photo-albums/${ID}/shares`, "POST", body, crossSite), albumParams))
        .status,
    ).toBe(403);
    state.identity = null;
    expect(
      (await share(request(`/photo-albums/${ID}/shares`, "POST", body), albumParams)).status,
    ).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("maps refusals, and a malformed album id is not found", async () => {
    const body = { shares: [{ homeId: HOME, access: "view" }] };
    for (const [outcome, status] of [
      ["not_permitted", 403],
      ["not_found", 404],
      ["limit", 409],
    ] as const) {
      answers({ share_photo_album: { outcome } });
      expect(
        (await share(request(`/photo-albums/${ID}/shares`, "POST", body), albumParams)).status,
      ).toBe(status);
    }
    state.rpc.mockReset();
    const bad = { params: Promise.resolve({ albumId: "nope" }) };
    expect((await share(request("/photo-albums/nope/shares", "POST", body), bad)).status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("removes the album from one Home, never deleting a photo", async () => {
    answers({ unshare_photo_album: { outcome: "removed" } });
    const response = await unshare(
      request(`/photo-albums/${ID}/shares`, "DELETE", { homeId: HOME }),
      albumParams,
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("unshare_photo_album", {
      p_album_id: ID,
      p_home_id: HOME,
    });
    expect(state.rpc).not.toHaveBeenCalledWith("delete_photos", expect.anything());
    answers({ unshare_photo_album: { outcome: "not_permitted" } });
    expect(
      (
        await unshare(
          request(`/photo-albums/${ID}/shares`, "DELETE", { homeId: HOME }),
          albumParams,
        )
      ).status,
    ).toBe(403);
  });
});

describe("deletion impact", () => {
  const value = {
    deletable: 1,
    skipped: 1,
    libraries: [{ personal: false, homeName: "Thuis" }],
    albums: ["Zomer"],
    otherAlbums: true,
    sharedHomes: [],
    otherHomes: false,
  };

  it("answers the impact without changing anything", async () => {
    answers({ photo_deletion_impact: value });
    const response = await impact(
      request("/photos/deletion-impact", "POST", { photoIds: [ID, ID2] }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ impact: value });
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect(state.rpc).toHaveBeenCalledWith("photo_deletion_impact", { p_photo_ids: [ID, ID2] });
  });

  it("refuses an empty list first, and a wrong shape is a failure", async () => {
    expect(
      (await impact(request("/photos/deletion-impact", "POST", { photoIds: [] }))).status,
    ).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
    answers({ photo_deletion_impact: { deletable: "x" } });
    expect(
      (await impact(request("/photos/deletion-impact", "POST", { photoIds: [ID] }))).status,
    ).toBe(500);
  });
});

describe("the photo widget", () => {
  const value = { available: true, photos: [{ id: ID, width: 10, height: 10 }], missing: 1 };

  it("reads an album or picked photos in order, in the widget's context", async () => {
    answers({ resolve_photo_widget: value });
    const byAlbum = await widget(request(`/photos/widget?homeId=${HOME}&albumId=${ID}`, "GET"));
    expect(byAlbum.status).toBe(200);
    expect(await byAlbum.json()).toEqual({ widget: value });
    expect(state.rpc).toHaveBeenLastCalledWith("resolve_photo_widget", {
      p_home_id: HOME,
      p_album_id: ID,
      p_photo_ids: null,
    });
    await widget(request(`/photos/widget?photoIds=${ID2},${ID}`, "GET"));
    expect(state.rpc).toHaveBeenLastCalledWith("resolve_photo_widget", {
      p_home_id: null,
      p_album_id: null,
      p_photo_ids: [ID2, ID],
    });
  });

  it("needs exactly one source and a signed-in viewer; a Home the viewer left is 404", async () => {
    expect((await widget(request("/photos/widget", "GET"))).status).toBe(400);
    expect(
      (await widget(request(`/photos/widget?albumId=${ID}&photoIds=${ID}`, "GET"))).status,
    ).toBe(400);
    expect((await widget(request("/photos/widget?photoIds=nope", "GET"))).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
    answers({ resolve_photo_widget: null });
    expect(
      (await widget(request(`/photos/widget?homeId=${HOME}&albumId=${ID}`, "GET"))).status,
    ).toBe(404);
    state.identity = null;
    expect((await widget(request(`/photos/widget?albumId=${ID}`, "GET"))).status).toBe(401);
  });
});
