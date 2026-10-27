import type { Mock } from "vitest";

import { POST as coverIntent } from "./cover-uploads/route";
import { GET as listDrafts } from "./drafts/route";
import { DELETE as unfavorite, PUT as favorite } from "./[recipeId]/favorite/route";
import { DELETE as release, PATCH as renew, POST as acquire } from "./[recipeId]/lock/route";
import { POST as publish } from "./[recipeId]/publish/route";
import { DELETE as clearRating, PUT as rate } from "./[recipeId]/rating/route";
import { DELETE as deleteRecipe, GET as getRecipe, PATCH as saveRecipe } from "./[recipeId]/route";
import { GET as listRecipes, POST as createRecipe } from "./route";
import { GET as widget } from "./widget/route";

interface State {
  identity: { userId: string } | null;
  storage: object | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  storage: null,
  rpc: vi.fn(),
}));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const RECIPE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const TOKEN = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0030";
const MEMBER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";
const REQUEST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0050";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args?: Record<string, unknown>) =>
        Promise.resolve(state.rpc(name, args ?? {})),
    }),
}));
vi.mock("@/storage/server", () => ({ getStorage: () => state.storage }));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };

function request(
  path: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = sameOrigin,
): Request {
  return new Request(`https://madeora.example/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const params = (recipeId: string) => ({ params: Promise.resolve({ recipeId }) });

function answers(outcomes: Record<string, unknown>) {
  state.rpc.mockImplementation((name) =>
    name in outcomes
      ? { data: outcomes[name], error: null }
      : { data: null, error: { code: "XX000", message: "unexpected" } },
  );
}

const content = {
  name: "  Stoofvlees ",
  servings: 4,
  servingsLabel: null,
  prepMinutes: 20,
  cookMinutes: 180,
  notes: null,
  tags: ["Vlaams", "Winter"],
  ingredients: [
    { name: "Rundvlees", quantity: { num: 1, den: 1, style: "decimal" }, unit: "kg", note: null },
    { name: "Bruin bier", quantity: { num: 1, den: 2, style: "fraction" }, unit: "l", note: null },
  ],
  steps: ["Bak het vlees aan.", "Stoof drie uur."],
  coverFileId: null,
};

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.storage = null;
  state.rpc.mockReset();
});

describe("every recipe mutation", () => {
  const calls: readonly [string, (headers?: Record<string, string>) => Promise<Response>][] = [
    [
      "create",
      (h) =>
        createRecipe(
          request("/recipes", "POST", { id: RECIPE, homeId: null, publish: false, content }, h),
        ),
    ],
    [
      "save",
      (h) =>
        saveRecipe(
          request(
            `/recipes/${RECIPE}`,
            "PATCH",
            { revision: 1, content, lockToken: null, draftHomeId: null },
            h,
          ),
          params(RECIPE),
        ),
    ],
    [
      "publish",
      (h) =>
        publish(
          request(
            `/recipes/${RECIPE}/publish`,
            "POST",
            { revision: 1, requestId: REQUEST, homeId: HOME },
            h,
          ),
          params(RECIPE),
        ),
    ],
    ["delete", (h) => deleteRecipe(request(`/recipes/${RECIPE}`, "DELETE", {}, h), params(RECIPE))],
    [
      "lock",
      (h) =>
        acquire(
          request(`/recipes/${RECIPE}/lock`, "POST", { token: TOKEN, takeOver: false }, h),
          params(RECIPE),
        ),
    ],
    [
      "rate",
      (h) => rate(request(`/recipes/${RECIPE}/rating`, "PUT", { stars: 4 }, h), params(RECIPE)),
    ],
    [
      "favorite",
      (h) => favorite(request(`/recipes/${RECIPE}/favorite`, "PUT", {}, h), params(RECIPE)),
    ],
  ];

  it.each(calls)(
    "%s refuses a cross-site request before touching the database",
    async (_, call) => {
      const response = await call({ origin: "https://evil.example", host: "madeora.example" });
      expect(response.status).toBe(403);
      expect(state.rpc).not.toHaveBeenCalled();
    },
  );

  it.each(calls)("%s refuses a signed-out caller", async (_, call) => {
    state.identity = null;
    const response = await call();
    expect(response.status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("creating and saving", () => {
  it("creates a private draft with normalized content and its client id", async () => {
    answers({ create_recipe: [{ outcome: "created", revision: 1, status: "draft" }] });
    const response = await createRecipe(
      request("/recipes", "POST", { id: RECIPE, homeId: HOME, publish: false, content }),
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: RECIPE, revision: 1, status: "draft" });
    const [, args] = state.rpc.mock.calls[0] ?? [];
    expect(args).toMatchObject({ p_id: RECIPE, p_home_id: HOME, p_publish: false });
    expect((args?.p_content as { name: string }).name).toBe("Stoofvlees");
  });

  it("answers a retry with the same recipe, not a second one", async () => {
    answers({ create_recipe: [{ outcome: "exists", revision: 1, status: "draft" }] });
    const response = await createRecipe(
      request("/recipes", "POST", { id: RECIPE, homeId: null, publish: false, content }),
    );
    expect(response.status).toBe(200);
  });

  it.each([
    [
      "a quantity of zero",
      {
        ingredients: [
          { ...content.ingredients[0], quantity: { num: 0, den: 1, style: "decimal" } },
        ],
      },
    ],
    [
      "an unreduced fraction",
      {
        ingredients: [
          { ...content.ingredients[0], quantity: { num: 2, den: 4, style: "fraction" } },
        ],
      },
    ],
    [
      "a decimal that is a third",
      {
        ingredients: [
          { ...content.ingredients[0], quantity: { num: 1, den: 3, style: "decimal" } },
        ],
      },
    ],
    ["an unknown unit", { ingredients: [{ ...content.ingredients[0], unit: "bucket" }] }],
    ["the same tag twice", { tags: ["Vegan", "végan"] }],
    ["servings of zero", { servings: 0 }],
    ["an empty step", { steps: ["  "] }],
    ["21 tags", { tags: Array.from({ length: 21 }, (_, i) => `tag ${String(i)}`) }],
  ])("refuses %s before touching the database", async (_, change) => {
    const response = await createRecipe(
      request("/recipes", "POST", {
        id: RECIPE,
        homeId: null,
        publish: false,
        content: { ...content, ...change },
      }),
    );
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("maps a Home the person is not in to 404, like one that does not exist", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not permitted" } });
    const response = await createRecipe(
      request("/recipes", "POST", { id: RECIPE, homeId: HOME, publish: true, content }),
    );
    expect(response.status).toBe(404);
  });

  it("passes the lock token when saving a published recipe", async () => {
    answers({ update_recipe: [{ outcome: "saved", revision: 3 }] });
    const response = await saveRecipe(
      request(`/recipes/${RECIPE}`, "PATCH", {
        revision: 2,
        content,
        lockToken: TOKEN,
        draftHomeId: null,
      }),
      params(RECIPE),
    );
    expect(response.status).toBe(200);
    expect(state.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_recipe_id: RECIPE,
      p_expected_revision: 2,
      p_lock_token: TOKEN,
    });
  });

  it.each([
    ["lock_lost", 409, "lock-lost"],
    ["conflict", 409, "conflict"],
    ["not_permitted", 403, "not-permitted"],
    ["not_found", 404, "not-found"],
    ["incomplete", 409, "incomplete"],
    ["destination_unavailable", 409, "destination-unavailable"],
    ["storage_full", 409, "storage-full"],
    ["invalid_cover", 409, "invalid-cover"],
  ])("answers a save refused with %s", async (outcome, status, error) => {
    answers({ update_recipe: [{ outcome, revision: 5 }] });
    const response = await saveRecipe(
      request(`/recipes/${RECIPE}`, "PATCH", {
        revision: 2,
        content,
        lockToken: TOKEN,
        draftHomeId: null,
      }),
      params(RECIPE),
    );
    expect(response.status).toBe(status);
    const body = (await response.json()) as { error: string; revision?: number };
    expect(body.error).toBe(error);
    if (outcome === "conflict") expect(body.revision).toBe(5);
  });

  it("treats a malformed id as not found", async () => {
    const response = await saveRecipe(
      request("/recipes/nope", "PATCH", {
        revision: 1,
        content,
        lockToken: null,
        draftHomeId: null,
      }),
      params("nope"),
    );
    expect(response.status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("publishing", () => {
  it("answers a double publish as already published", async () => {
    answers({ publish_recipe: [{ outcome: "already_published", revision: 2 }] });
    const response = await publish(
      request(`/recipes/${RECIPE}/publish`, "POST", {
        revision: 1,
        requestId: REQUEST,
        homeId: HOME,
      }),
      params(RECIPE),
    );
    expect(response.status).toBe(200);
    expect(state.rpc.mock.calls[0]?.[1]).toMatchObject({ p_home_id: HOME, p_request_id: REQUEST });
  });
});

describe("the editing lock", () => {
  it("answers someone else's lock with who holds it", async () => {
    answers({
      acquire_recipe_lock: [
        {
          outcome: "locked",
          revision: 2,
          expires_at: null,
          held_by_me: false,
          held_by_member: MEMBER,
        },
      ],
    });
    const response = await acquire(
      request(`/recipes/${RECIPE}/lock`, "POST", { token: TOKEN, takeOver: true }),
      params(RECIPE),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "locked",
      heldByMe: false,
      member: MEMBER,
    });
  });

  it("answers an acquired lock with the revision and expiry", async () => {
    answers({
      acquire_recipe_lock: [
        {
          outcome: "acquired",
          revision: 4,
          expires_at: "2026-10-27T12:02:00Z",
          held_by_me: true,
          held_by_member: null,
        },
      ],
    });
    const response = await acquire(
      request(`/recipes/${RECIPE}/lock`, "POST", { token: TOKEN, takeOver: false }),
      params(RECIPE),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      revision: 4,
      expiresAt: "2026-10-27T12:02:00Z",
    });
  });

  it("reports a lost lock on the heartbeat", async () => {
    answers({ renew_recipe_lock: [{ outcome: "lock_lost", expires_at: null }] });
    const response = await renew(
      request(`/recipes/${RECIPE}/lock`, "PATCH", { token: TOKEN }),
      params(RECIPE),
    );
    expect(response.status).toBe(409);
  });

  it("releases quietly, even a lock already gone", async () => {
    answers({ release_recipe_lock: false });
    const response = await release(
      request(`/recipes/${RECIPE}/lock`, "DELETE", { token: TOKEN }),
      params(RECIPE),
    );
    expect(response.status).toBe(200);
  });

  it("refuses to delete a recipe someone else is editing", async () => {
    answers({ delete_recipe: [{ outcome: "locked", entry_id: null }] });
    const response = await deleteRecipe(
      request(`/recipes/${RECIPE}`, "DELETE", {}),
      params(RECIPE),
    );
    expect(response.status).toBe(409);
  });
});

describe("ratings and favorites", () => {
  it("answers the rating summary without anyone's own rating", async () => {
    answers({
      set_recipe_rating: [{ outcome: "saved", mine: 4, average: "3.5", rating_count: 2 }],
    });
    const response = await rate(
      request(`/recipes/${RECIPE}/rating`, "PUT", { stars: 4 }),
      params(RECIPE),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ mine: 4, average: 3.5, count: 2 });
  });

  it("clears a rating without stars", async () => {
    answers({
      set_recipe_rating: [{ outcome: "cleared", mine: null, average: null, rating_count: 0 }],
    });
    const response = await clearRating(
      request(`/recipes/${RECIPE}/rating`, "DELETE", {}),
      params(RECIPE),
    );
    expect(response.status).toBe(200);
    expect(state.rpc.mock.calls[0]?.[1]).toEqual({ p_recipe_id: RECIPE });
  });

  it.each([0, 6, 2.5])("refuses %s stars", async (stars) => {
    const response = await rate(
      request(`/recipes/${RECIPE}/rating`, "PUT", { stars }),
      params(RECIPE),
    );
    expect(response.status).toBe(400);
  });

  it("answers a draft or unseen recipe as not found when favorited", async () => {
    answers({ set_recipe_favorite: "not_found" });
    const response = await unfavorite(
      request(`/recipes/${RECIPE}/favorite`, "DELETE", {}),
      params(RECIPE),
    );
    expect(response.status).toBe(404);
  });
});

describe("reads", () => {
  it("answers an unseen recipe or someone else's draft as not found", async () => {
    answers({ get_recipe: null });
    const response = await getRecipe(request(`/recipes/${RECIPE}`, "GET"), params(RECIPE));
    expect(response.status).toBe(404);
  });

  it("lists with the filters and every selected tag", async () => {
    answers({ list_recipes: [] });
    const response = await listRecipes(
      request(
        `/recipes?homeId=${HOME}&q=bier&tag=Vlaams&tag=Winter&sort=added_desc&favorites=1`,
        "GET",
      ),
    );
    expect(response.status).toBe(200);
    expect(state.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_home_id: HOME,
      p_query: "bier",
      p_tags: ["Vlaams", "Winter"],
      p_sort: "added_desc",
      p_favorites: true,
    });
  });

  it("lists only the caller's own drafts", async () => {
    answers({ list_my_recipe_drafts: [] });
    const response = await listDrafts();
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("list_my_recipe_drafts", {});
  });

  it("refuses an unknown widget mode", async () => {
    const response = await widget(request("/recipes/widget?mode=trending&limit=1", "GET"));
    expect(response.status).toBe(400);
  });

  it("reads a widget of the Personal space without a Home", async () => {
    answers({ recipe_widget: [] });
    const response = await widget(request("/recipes/widget?mode=random&limit=1&seed=abc", "GET"));
    expect(response.status).toBe(200);
    expect(state.rpc.mock.calls[0]?.[1]).toEqual({ p_mode: "random", p_limit: 1, p_seed: "abc" });
  });

  it("refuses a signed-out reader", async () => {
    state.identity = null;
    expect((await listDrafts()).status).toBe(401);
  });
});

describe("cover uploads", () => {
  const intent = {
    contentType: "image/jpeg",
    size: 1000,
    requestId: REQUEST,
    recipeId: RECIPE,
    lockToken: TOKEN,
  };

  it("answers 503 while storage is not configured", async () => {
    const response = await coverIntent(request("/recipes/cover-uploads", "POST", intent));
    expect(response.status).toBe(503);
  });

  it("refuses a type that is not a photo before touching the database", async () => {
    state.storage = {};
    const response = await coverIntent(
      request("/recipes/cover-uploads", "POST", { ...intent, contentType: "image/gif" }),
    );
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("signs a link bound to the intent", async () => {
    const presignPut = vi.fn(() => ({ url: "https://r2.example/put", headers: { a: "b" } }));
    state.storage = { objects: { presignPut } };
    answers({
      create_recipe_cover_intent: [
        { outcome: "ok", file_id: RECIPE, upload_key: "u/key", expires_at: "2026-10-27T12:15:00Z" },
      ],
    });
    const response = await coverIntent(request("/recipes/cover-uploads", "POST", intent));
    expect(response.status).toBe(201);
    expect(presignPut).toHaveBeenCalledWith("u/key", {
      contentType: "image/jpeg",
      contentLength: 1000,
      expiresInSeconds: 300,
    });
  });
});
