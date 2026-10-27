import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { RecipeDeleteImpact, RecipeImportPreview, RecipeShare } from "@/recipes/api";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { RecipeDelete } from "./recipe-delete";
import { previewToForm, RecipeImport } from "./recipe-import";
import { RecipeSharePanel } from "./recipe-share-panel";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const RECIPE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const BEACH = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0002";
const CABIN = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0003";
const DUPLICATE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021";

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sent(call: number): { url: string; method: string; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls[call] ?? ["", undefined];
  return {
    url,
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  router.refresh.mockReset();
  router.push.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the share panel", () => {
  const shares: RecipeShare[] = [
    {
      homeId: BEACH,
      homeName: "Beach house",
      state: "active",
      canEdit: false,
      sharedAt: "2026-10-20T10:00:00Z",
    },
    {
      homeId: CABIN,
      homeName: "Cabin",
      state: "paused",
      canEdit: true,
      sharedAt: "2026-10-19T10:00:00Z",
    },
    { homeId: HOME, homeName: "Grandma's", state: "available", canEdit: false, sharedAt: null },
  ];

  it("shares only after the consequences are confirmed", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(200, { outcome: "shared" }));
    const { container } = renderWithQuery(
      <RecipeSharePanel recipeId={RECIPE} recipeName="Pancakes" shares={shares} />,
    );
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByLabelText("Let recipe managers of that Home edit it"));
    await user.click(screen.getByTestId("recipe-share-submit"));
    const dialog = await screen.findByRole("dialog", { name: "Share with Grandma's?" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await axeViolations(document.body)).toEqual([]);
    await user.click(within(dialog).getByTestId("recipe-share-confirm"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(sent(0)).toMatchObject({
      method: "PUT",
      url: `/api/v1/recipes/${RECIPE}/shares`,
      body: { homeId: HOME, canEdit: true },
    });
    expect(await screen.findByText("Sharing updated.")).toBeInTheDocument();
  });

  it("names each Home on its buttons and reinstates a paused share", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(200, { outcome: "shared" }));
    renderWithQuery(<RecipeSharePanel recipeId={RECIPE} recipeName="Pancakes" shares={shares} />);
    expect(
      screen.getByRole("button", { name: "Stop sharing with Beach house" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Turn sharing with Cabin back on" }));
    await waitFor(() => {
      expect(sent(0).body).toEqual({ homeId: CABIN, canEdit: false });
    });
  });

  it("removes a share only after confirming what that Home loses", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(200, { outcome: "unshared" }));
    renderWithQuery(<RecipeSharePanel recipeId={RECIPE} recipeName="Pancakes" shares={shares} />);
    await user.click(screen.getByRole("button", { name: "Stop sharing with Beach house" }));
    const dialog = await screen.findByRole("dialog", { name: "Stop sharing with Beach house?" });
    expect(dialog).toHaveTextContent("favorites of it there are removed");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await axeViolations(document.body)).toEqual([]);
    await user.click(within(dialog).getByTestId("recipe-narrow-confirm"));
    await waitFor(() => {
      expect(sent(0)).toMatchObject({ method: "DELETE", body: { homeId: BEACH } });
    });
  });

  it("confirms making an editable share view only, but not the other way round", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(200, { outcome: "updated" }));
    const editable: RecipeShare[] = [
      { homeId: BEACH, homeName: "Beach house", state: "active", canEdit: true, sharedAt: null },
      { homeId: CABIN, homeName: "Cabin", state: "active", canEdit: false, sharedAt: null },
    ];
    renderWithQuery(<RecipeSharePanel recipeId={RECIPE} recipeName="Pancakes" shares={editable} />);
    await user.click(screen.getByRole("button", { name: "Let recipe managers of Cabin edit" }));
    await waitFor(() => {
      expect(sent(0).body).toEqual({ homeId: CABIN, canEdit: true });
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Make Beach house view only" }));
    const dialog = await screen.findByRole("dialog", { name: "Make it view only in Beach house?" });
    await user.click(within(dialog).getByTestId("recipe-narrow-confirm"));
    await waitFor(() => {
      expect(sent(1).body).toEqual({ homeId: BEACH, canEdit: false });
    });
  });

  it("shows the refusal and keeps the dialog open when sharing fails", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(403, { error: "not-permitted" }));
    renderWithQuery(<RecipeSharePanel recipeId={RECIPE} recipeName="Pancakes" shares={shares} />);
    await user.click(screen.getByTestId("recipe-share-submit"));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByTestId("recipe-share-confirm"));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
  });
});

describe("impact-reviewed deletion", () => {
  const impact: RecipeDeleteImpact = {
    token: "token-1",
    status: "published",
    homeId: HOME,
    shares: [{ homeId: BEACH, homeName: "Beach house", canEdit: false }],
    favoriteCount: 2,
    beingEdited: false,
  };

  it("lists the Homes it is shared with and deletes with the review's token", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, impact))
      .mockResolvedValueOnce(jsonResponse(200, { id: RECIPE }));
    renderWithQuery(
      <RecipeDelete
        recipeId={RECIPE}
        draft={false}
        after="/recipes"
        sharePath="/recipes/x/share"
      />,
    );
    await user.click(screen.getByTestId("recipe-delete"));
    const homes = await screen.findByTestId("recipe-impact-homes");
    expect(homes).toHaveTextContent("Beach house");
    expect(screen.getByRole("link", { name: /instead/i })).toHaveAttribute(
      "href",
      "/recipes/x/share",
    );
    expect(await axeViolations(document.body)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Delete everywhere" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/recipes?deleted=1");
    });
    expect(sent(1)).toMatchObject({ method: "DELETE", body: { impactToken: "token-1" } });
  });

  it("looks again instead of deleting when the shares changed meanwhile", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { ...impact, shares: [] }))
      .mockResolvedValueOnce(jsonResponse(409, { error: "stale-impact" }))
      .mockResolvedValueOnce(jsonResponse(200, { ...impact, token: "token-2" }));
    renderWithQuery(<RecipeDelete recipeId={RECIPE} draft={false} after="/recipes" />);
    await user.click(screen.getByTestId("recipe-delete"));
    await user.click(await screen.findByTestId("recipe-delete-confirm"));
    expect(await screen.findByTestId("recipe-impact-homes")).toHaveTextContent("Beach house");
    expect(screen.getByText(/changed since you opened this/)).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("does not offer the delete while someone is editing", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ...impact, beingEdited: true }));
    renderWithQuery(<RecipeDelete recipeId={RECIPE} draft={false} after="/recipes" />);
    await user.click(screen.getByTestId("recipe-delete"));
    await screen.findByTestId("recipe-impact-homes");
    expect(screen.getByTestId("recipe-delete-confirm")).toBeDisabled();
  });

  it("discards a draft without an impact review", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: RECIPE }));
    renderWithQuery(<RecipeDelete recipeId={RECIPE} draft after="/recipes/drafts" />);
    await user.click(screen.getByTestId("recipe-delete"));
    await user.click(await screen.findByTestId("recipe-delete-confirm"));
    await waitFor(() => {
      expect(sent(0)).toMatchObject({ method: "DELETE", body: {} });
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("importing", () => {
  const preview: RecipeImportPreview = {
    source: { url: "https://recipes.example/soup", name: "Recipes Example" },
    name: "Soup",
    servings: 2,
    servingsLabel: null,
    prepMinutes: 5,
    cookMinutes: null,
    notes: null,
    tags: ["Winter"],
    ingredients: [
      { name: "water", quantity: "1", unit: "l", asWritten: false },
      { name: "2-3 carrots", quantity: "", unit: null, asWritten: true },
    ],
    steps: ["Boil."],
    warnings: ["ingredientsAsWritten"],
    duplicates: [{ id: DUPLICATE, name: "Soup", status: "published", match: "source" }],
  };

  it("turns a preview into editor values without adding anything", () => {
    expect(previewToForm(preview)).toEqual({
      name: "Soup",
      servings: "2",
      servingsLabel: "",
      prepMinutes: "5",
      cookMinutes: "",
      notes: "",
      tags: ["Winter"],
      ingredients: [
        { name: "water", quantity: "1", unit: "l", note: "" },
        { name: "2-3 carrots", quantity: "", unit: "", note: "" },
      ],
      steps: [{ text: "Boil." }],
      coverFileId: null,
    });
  });

  it("shows the review with source, warnings and duplicates, and saves nothing yet", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, preview));
    const { container } = renderWithQuery(
      <RecipeImport homeId={HOME} homes={[{ id: HOME, name: "Home" }]} />,
    );
    expect(await axeViolations(container)).toEqual([]);
    await user.type(
      screen.getByLabelText(/Web address of the recipe/),
      "https://recipes.example/soup",
    );
    await user.click(screen.getByTestId("recipe-import-submit"));
    expect(await screen.findByRole("heading", { name: "Check the imported recipe" })).toHaveFocus();
    expect(sent(0)).toMatchObject({
      method: "POST",
      body: { url: "https://recipes.example/soup", homeId: HOME },
    });
    expect(screen.getByTestId("recipe-import-warnings")).toHaveTextContent("kept as written");
    expect(screen.getByTestId("recipe-import-duplicates")).toHaveTextContent("Soup");
    expect(screen.getByRole("link", { name: /recipes\.example|Recipes Example/ })).toHaveAttribute(
      "href",
      "https://recipes.example/soup",
    );
    expect(screen.getByTestId("recipe-editor")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("says why a page cannot be imported and offers manual entry", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, { error: "import-failed", reason: "blocked" }),
    );
    renderWithQuery(<RecipeImport homeId={null} homes={[]} />);
    await user.type(screen.getByLabelText(/Web address of the recipe/), "http://192.168.1.1/");
    await user.click(screen.getByTestId("recipe-import-submit"));
    const failure = await screen.findByTestId("recipe-import-failure");
    expect(failure).toHaveTextContent("private or local network");
    expect(within(failure).getByTestId("recipe-import-manual")).toHaveAttribute(
      "href",
      "/recipes/new",
    );
    await waitFor(() => {
      expect(failure).toHaveFocus();
    });
  });

  it("explains the hourly limit and still offers manual entry", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: "rate-limited" }));
    renderWithQuery(<RecipeImport homeId={null} homes={[]} />);
    await user.type(
      screen.getByLabelText(/Web address of the recipe/),
      "https://recipes.example/soup",
    );
    await user.click(screen.getByTestId("recipe-import-submit"));
    const failure = await screen.findByTestId("recipe-import-failure");
    expect(within(failure).getByTestId("recipe-import-manual")).toHaveAttribute(
      "href",
      "/recipes/new",
    );
  });
});
