import type { Mock } from "vitest";

import type { FetchResult } from "@/recipes/import/fetch";

import { GET as deleteImpact } from "./[recipeId]/delete-impact/route";
import { DELETE as deleteRecipe, GET as getRecipe } from "./[recipeId]/route";
import { DELETE as unshare, GET as listShares, PUT as share } from "./[recipeId]/shares/route";
import { POST as importRecipe } from "./import/route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
  fetchPage: Mock<(url: string) => Promise<FetchResult>>;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  rpc: vi.fn(),
  fetchPage: vi.fn(),
}));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const OTHER_HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0002";
const RECIPE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const DUPLICATE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021";

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
vi.mock("@/recipes/import/fetch", () => ({
  fetchRecipePage: (url: string) => state.fetchPage(url),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };

function request(path: string, method: string, body?: unknown, headers = sameOrigin): Request {
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

const callsTo = (name: string) => state.rpc.mock.calls.filter(([called]) => called === name);

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
  state.fetchPage.mockReset();
});

describe("sharing", () => {
  it("shares with a Home and passes exactly what was asked", async () => {
    answers({ share_recipe: "shared" });
    const response = await share(
      request(`/recipes/${RECIPE}/shares`, "PUT", { homeId: OTHER_HOME, canEdit: true }),
      params(RECIPE),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: "shared" });
    expect(callsTo("share_recipe")[0]?.[1]).toEqual({
      p_recipe_id: RECIPE,
      p_home_id: OTHER_HOME,
      p_can_edit: true,
    });
  });

  it.each([
    ["unchanged", 200],
    ["updated", 200],
    ["not_found", 404],
    ["not_permitted", 403],
  ])("answers %s with %i", async (outcome, status) => {
    answers({ share_recipe: outcome });
    const response = await share(
      request(`/recipes/${RECIPE}/shares`, "PUT", { homeId: OTHER_HOME, canEdit: false }),
      params(RECIPE),
    );
    expect(response.status).toBe(status);
  });

  it("refuses a share request from another site, before any database call", async () => {
    const response = await share(
      request(
        `/recipes/${RECIPE}/shares`,
        "PUT",
        { homeId: OTHER_HOME, canEdit: false },
        { origin: "https://evil.example", host: "madeora.example" },
      ),
      params(RECIPE),
    );
    expect(response.status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each([
    { homeId: "not-a-uuid", canEdit: false },
    { homeId: OTHER_HOME },
    { homeId: OTHER_HOME, canEdit: false, extra: 1 },
  ])("refuses a malformed share %j", async (body) => {
    const response = await share(request(`/recipes/${RECIPE}/shares`, "PUT", body), params(RECIPE));
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses everything to someone signed out", async () => {
    state.identity = null;
    const listed = await listShares(request(`/recipes/${RECIPE}/shares`, "GET"), params(RECIPE));
    expect(listed.status).toBe(401);
    const shared = await share(
      request(`/recipes/${RECIPE}/shares`, "PUT", { homeId: OTHER_HOME, canEdit: false }),
      params(RECIPE),
    );
    expect(shared.status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("lists shares by state", async () => {
    answers({
      list_recipe_shares: [
        {
          home_id: OTHER_HOME,
          home_name: "Beach house",
          state: "paused",
          can_edit: true,
          shared_at: "2026-10-20T10:00:00Z",
        },
        { home_id: HOME, home_name: "Home", state: "available", can_edit: false, shared_at: null },
      ],
    });
    const response = await listShares(request(`/recipes/${RECIPE}/shares`, "GET"), params(RECIPE));
    await expect(response.json()).resolves.toEqual({
      shares: [
        {
          homeId: OTHER_HOME,
          homeName: "Beach house",
          state: "paused",
          canEdit: true,
          sharedAt: "2026-10-20T10:00:00Z",
        },
        { homeId: HOME, homeName: "Home", state: "available", canEdit: false, sharedAt: null },
      ],
    });
  });

  it("removes a share from one Home", async () => {
    answers({ unshare_recipe: "unshared" });
    const response = await unshare(
      request(`/recipes/${RECIPE}/shares`, "DELETE", { homeId: OTHER_HOME }),
      params(RECIPE),
    );
    expect(response.status).toBe(200);
    expect(callsTo("unshare_recipe")[0]?.[1]).toEqual({
      p_recipe_id: RECIPE,
      p_home_id: OTHER_HOME,
    });
  });

  it("reads a recipe in the context it is seen from", async () => {
    answers({ get_recipe: null });
    const response = await getRecipe(
      request(`/recipes/${RECIPE}?homeId=${OTHER_HOME}`, "GET"),
      params(RECIPE),
    );
    expect(response.status).toBe(404);
    expect(callsTo("get_recipe")[0]?.[1]).toMatchObject({
      p_recipe_id: RECIPE,
      p_home_id: OTHER_HOME,
    });
  });
});

describe("impact-reviewed deletion", () => {
  const impact = {
    token: "abc123",
    status: "published",
    homeId: HOME,
    shares: [{ homeId: OTHER_HOME, homeName: "Beach house", canEdit: false }],
    favoriteCount: 3,
    plannedMeals: 0,
    repeatingMeals: 0,
    beingEdited: false,
  };

  it("answers the impact for someone who may delete", async () => {
    answers({ recipe_delete_impact: [{ outcome: "ok", impact }] });
    const response = await deleteImpact(
      request(`/recipes/${RECIPE}/delete-impact`, "GET"),
      params(RECIPE),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(impact);
  });

  it.each([
    ["not_permitted", 403],
    ["not_found", 404],
  ])("answers %s with %i and no impact", async (outcome, status) => {
    answers({ recipe_delete_impact: [{ outcome, impact: null }] });
    const response = await deleteImpact(
      request(`/recipes/${RECIPE}/delete-impact`, "GET"),
      params(RECIPE),
    );
    expect(response.status).toBe(status);
  });

  it("refuses an impact of an unexpected shape", async () => {
    answers({ recipe_delete_impact: [{ outcome: "ok", impact: { token: 1 } }] });
    const response = await deleteImpact(
      request(`/recipes/${RECIPE}/delete-impact`, "GET"),
      params(RECIPE),
    );
    expect(response.status).toBe(500);
  });

  it("sends the token back with the delete", async () => {
    answers({ delete_recipe: [{ outcome: "deleted", entry_id: null }] });
    const response = await deleteRecipe(
      request(`/recipes/${RECIPE}`, "DELETE", { impactToken: "abc123" }),
      params(RECIPE),
    );
    expect(response.status).toBe(200);
    expect(callsTo("delete_recipe")[0]?.[1]).toEqual({
      p_recipe_id: RECIPE,
      p_impact_token: "abc123",
    });
  });

  it.each([
    ["impact_review_required", "impact-review-required"],
    ["stale_impact", "stale-impact"],
  ])("answers %s as a conflict", async (outcome, error) => {
    answers({ delete_recipe: [{ outcome, entry_id: null }] });
    const response = await deleteRecipe(
      request(`/recipes/${RECIPE}`, "DELETE", {}),
      params(RECIPE),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error });
  });
});

describe("importing", () => {
  const page =
    '<script type="application/ld+json">{"@type":"Recipe","name":"Soup","recipeIngredient":["1 l water"],"recipeInstructions":"Boil.","recipeYield":"2"}</script>';
  const URL_ = "https://recipes.example/soup";

  function importAnswers(overrides: Record<string, unknown> = {}) {
    answers({
      get_recipe_context: [{ can_create: true, can_manage: false }],
      begin_recipe_import: "ok",
      find_recipe_duplicates: [
        { id: DUPLICATE, name: "Soup", status: "published", match: "source" },
      ],
      ...overrides,
    });
  }

  it("answers an editable preview with duplicates, and stores nothing", async () => {
    importAnswers();
    state.fetchPage.mockResolvedValue({ ok: true, url: URL_, body: page });
    const response = await importRecipe(
      request("/recipes/import", "POST", { url: URL_, homeId: HOME }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      name: "Soup",
      servings: 2,
      source: { url: URL_ },
      steps: ["Boil."],
      duplicates: [{ id: DUPLICATE, name: "Soup", status: "published", match: "source" }],
    });
    expect(state.rpc.mock.calls.map(([name]) => name)).toEqual([
      "get_recipe_context",
      "begin_recipe_import",
      "find_recipe_duplicates",
    ]);
    expect(callsTo("find_recipe_duplicates")[0]?.[1]).toEqual({
      p_home_id: HOME,
      p_name: "Soup",
      p_source_url: URL_,
    });
  });

  it.each(["blocked", "timeout", "too_large", "not_html", "invalid_url"] as const)(
    "says why when the page is refused (%s)",
    async (reason) => {
      importAnswers();
      state.fetchPage.mockResolvedValue({ ok: false, reason });
      const response = await importRecipe(
        request("/recipes/import", "POST", { url: URL_, homeId: null }),
      );
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toEqual({ error: "import-failed", reason });
    },
  );

  it("says no_recipe for a page without one", async () => {
    importAnswers();
    state.fetchPage.mockResolvedValue({ ok: true, url: URL_, body: "<html></html>" });
    const response = await importRecipe(
      request("/recipes/import", "POST", { url: URL_, homeId: null }),
    );
    await expect(response.json()).resolves.toEqual({ error: "import-failed", reason: "no_recipe" });
  });

  it("refuses over the hourly limit without fetching", async () => {
    importAnswers({ begin_recipe_import: "rate_limited" });
    const response = await importRecipe(
      request("/recipes/import", "POST", { url: URL_, homeId: null }),
    );
    expect(response.status).toBe(429);
    expect(state.fetchPage).not.toHaveBeenCalled();
  });

  it("refuses a destination the person cannot add recipes to, before taking a slot or fetching", async () => {
    importAnswers({ get_recipe_context: [{ can_create: false, can_manage: false }] });
    const refused = await importRecipe(
      request("/recipes/import", "POST", { url: URL_, homeId: HOME }),
    );
    expect(refused.status).toBe(403);
    importAnswers({ get_recipe_context: [] });
    const unknown = await importRecipe(
      request("/recipes/import", "POST", { url: URL_, homeId: HOME }),
    );
    expect(unknown.status).toBe(404);
    expect(callsTo("begin_recipe_import")).toHaveLength(0);
    expect(state.fetchPage).not.toHaveBeenCalled();
  });

  it("refuses a cross-site import and malformed input before anything else", async () => {
    importAnswers();
    const crossSite = await importRecipe(
      request(
        "/recipes/import",
        "POST",
        { url: URL_, homeId: null },
        {
          origin: "https://evil.example",
          host: "madeora.example",
        },
      ),
    );
    expect(crossSite.status).toBe(403);
    for (const body of [
      { url: "", homeId: null },
      { url: URL_ },
      { url: "x".repeat(2001), homeId: null },
    ]) {
      const response = await importRecipe(request("/recipes/import", "POST", body));
      expect(response.status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.fetchPage).not.toHaveBeenCalled();
  });
});
