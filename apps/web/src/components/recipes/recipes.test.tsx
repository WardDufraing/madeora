import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { RecipeDetail, RecipeIngredient } from "@/recipes/api";
import { emptyRecipeForm } from "@/recipes/schema";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { CookingMode } from "./cooking-mode";
import { RecipeEditSession } from "./recipe-edit-session";
import { RecipeEditor } from "./recipe-editor";
import { RecipeFavorite, RecipeRating } from "./recipe-reactions";
import { RecipeServings } from "./recipe-servings";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const RECIPE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const MEMBER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";

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
  router.replace.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ingredients: RecipeIngredient[] = [
  { name: "Flour", quantity: { num: 250, den: 1, style: "decimal" }, unit: "g", note: null },
  { name: "Milk", quantity: { num: 1, den: 3, style: "fraction" }, unit: "l", note: "warm" },
  { name: "Salt", quantity: null, unit: null, note: null },
];

function detail(overrides: Partial<RecipeDetail> = {}): RecipeDetail {
  return {
    id: RECIPE,
    status: "published",
    homeId: HOME,
    contextHomeId: HOME,
    sharedIn: false,
    source: null,
    isShared: false,
    shareCount: 0,
    draftHomeId: null,
    destinationLost: false,
    name: "Pancakes",
    servings: 4,
    servingsLabel: null,
    prepMinutes: 10,
    cookMinutes: 20,
    notes: null,
    tags: ["Breakfast"],
    coverFileId: null,
    ingredients,
    steps: ["Mix everything.", "Bake in a hot pan."],
    revision: 3,
    createdAt: "2026-10-20T10:00:00Z",
    createdBy: { me: true, member: null },
    updatedAt: "2026-10-20T10:00:00Z",
    updatedBy: { me: true, member: null },
    publishedAt: "2026-10-20T10:00:00Z",
    favorite: false,
    rating: { mine: null, average: null, count: 0 },
    lock: null,
    can: {
      edit: true,
      delete: true,
      rate: true,
      favorite: true,
      publish: false,
      share: false,
      unshareHere: false,
    },
    ...overrides,
  };
}

describe("serving scaling", () => {
  it("scales exactly and marks what it cannot scale", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQuery(
      <RecipeServings ingredients={ingredients} original={4} servingsLabel={null} initial={null} />,
    );
    const list = screen.getByTestId("recipe-ingredients");
    expect(list).toHaveTextContent("250 g Flour");
    expect(list).toHaveTextContent("1/3 l Milk, warm");
    await user.click(screen.getByRole("button", { name: "More servings" }));
    await user.click(screen.getByRole("button", { name: "More servings" }));
    // 4 → 6: 375 g; a third of a litre becomes exactly a half.
    expect(list).toHaveTextContent("375 g Flour");
    expect(list).toHaveTextContent("1/2 l Milk");
    expect(list).toHaveTextContent("Salt (no amount, not scaled)");
    expect(screen.getByTestId("servings-summary")).toHaveTextContent(
      "Amounts scaled to 6 servings (the recipe makes 4).",
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it("explains why there is no scaling without a recorded yield", () => {
    renderWithQuery(
      <RecipeServings ingredients={ingredients} original={null} servingsLabel={null} initial={7} />,
    );
    expect(screen.getByText(/has no number of servings/)).toBeInTheDocument();
    expect(screen.getByTestId("recipe-ingredients")).toHaveTextContent("250 g Flour");
  });

  it("marks rounded amounts as approximate and shows the exact value on request", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <RecipeServings
        ingredients={[
          { name: "Sugar", quantity: { num: 1, den: 1, style: "decimal" }, unit: "g", note: null },
        ]}
        original={3}
        servingsLabel={null}
        initial={2}
      />,
    );
    const list = screen.getByTestId("recipe-ingredients");
    expect(list).toHaveTextContent("≈ 0.67 g Sugar");
    await user.click(screen.getByLabelText("Show exact amounts"));
    expect(list).toHaveTextContent("2/3 g Sugar");
  });
});

describe("rating and favorites", () => {
  it("rates with a radio group and shows the summary the server answers", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(200, { mine: 4, average: 3.5, count: 2 }));
    const { container } = renderWithQuery(
      <RecipeRating
        recipeId={RECIPE}
        homeId={null}
        rating={{ mine: null, average: 3, count: 1 }}
      />,
    );
    await user.click(screen.getByRole("radio", { name: "4 stars" }));
    await waitFor(() => {
      expect(screen.getByTestId("rating-summary")).toHaveTextContent("3.5 out of 5 · 2 ratings");
    });
    expect(sent(0)).toMatchObject({ method: "PUT", body: { stars: 4 } });
    expect(await axeViolations(container)).toEqual([]);
  });

  it("puts the favorite back when the server refuses", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(404, { error: "not-found" }));
    renderWithQuery(<RecipeFavorite recipeId={RECIPE} homeId={null} favorite={false} />);
    const toggle = screen.getByTestId("recipe-favorite");
    await user.click(toggle);
    await waitFor(() => {
      expect(toggle).toHaveAttribute("aria-pressed", "false");
    });
    expect(screen.getByRole("alert")).toHaveTextContent("no longer available");
  });
});

describe("the editor", () => {
  it("saves a new recipe as a private draft with its client id and destination", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(201, { id: RECIPE, revision: 1, status: "draft" }));
    const { container } = renderWithQuery(
      <RecipeEditor
        mode="new"
        recipeId={RECIPE}
        homeId={HOME}
        homes={[{ id: HOME, name: "Our home" }]}
        initial={emptyRecipeForm()}
      />,
    );
    expect(screen.getByText("Only you can see a draft until you publish it.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Ingredient"), "Eggs");
    await user.type(screen.getByLabelText("Amount"), "1 1/2");
    await user.click(screen.getByTestId("recipe-save-draft"));
    await waitFor(() => {
      expect(window.location.pathname).toBe(`/recipes/drafts/${RECIPE}`);
    });
    expect(screen.getByText("Draft saved. Only you can see it.")).toBeInTheDocument();
    const request = sent(0);
    expect(request).toMatchObject({ url: "/api/v1/recipes", method: "POST" });
    expect(request.body).toMatchObject({ id: RECIPE, homeId: HOME, publish: false });
    expect((request.body.content as { ingredients: unknown[] }).ingredients).toEqual([
      { name: "Eggs", quantity: { num: 3, den: 2, style: "fraction" }, unit: null, note: null },
    ]);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("refuses to publish without a name and an ingredient or step, before sending", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <RecipeEditor
        mode="new"
        recipeId={RECIPE}
        homeId={null}
        homes={[]}
        initial={emptyRecipeForm()}
      />,
    );
    await user.click(screen.getByTestId("recipe-publish"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription(/Fill this in/);
  });

  it("names the audience before publishing to a Home", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse(201, { id: RECIPE, revision: 1, status: "published" }),
    );
    renderWithQuery(
      <RecipeEditor
        mode="new"
        recipeId={RECIPE}
        homeId={HOME}
        homes={[{ id: HOME, name: "Our home" }]}
        initial={emptyRecipeForm()}
      />,
    );
    await user.type(screen.getByLabelText("Name"), "Soup");
    await user.type(screen.getByLabelText("Step 1"), "Boil.");
    await user.click(screen.getByTestId("recipe-publish"));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Everyone in Our home can see it.");
    await user.click(within(dialog).getByTestId("recipe-publish-confirm"));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(`/homes/${HOME}/recipes/${RECIPE}`);
    });
    expect(sent(0).body).toMatchObject({ publish: true, homeId: HOME });
  });

  it("moves ingredient rows with buttons, not only by dragging", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <RecipeEditor
        mode="new"
        recipeId={RECIPE}
        homeId={null}
        homes={[]}
        initial={emptyRecipeForm()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add ingredient" }));
    const names = () => screen.getAllByLabelText<HTMLInputElement>("Ingredient");
    await user.type(names()[0] as HTMLInputElement, "First");
    await user.type(names()[1] as HTMLInputElement, "Second");
    await user.click(screen.getByRole("button", { name: "Move Ingredient 2 up" }));
    expect(names().map((input) => input.value)).toEqual(["Second", "First"]);
  });
});

describe("editing under the lock", () => {
  it("shows who is editing instead of the editor", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, { error: "locked", heldByMe: false, member: MEMBER }),
    );
    renderWithQuery(
      <RecipeEditSession
        recipeId={RECIPE}
        homeId={HOME}
        revision={3}
        shared={false}
        initial={emptyRecipeForm()}
        members={[{ id: MEMBER, name: "Sam", isSelf: false }]}
      />,
    );
    expect(await screen.findByTestId("recipe-locked")).toHaveTextContent(
      "Sam is editing this recipe right now.",
    );
    expect(screen.queryByTestId("recipe-editor")).not.toBeInTheDocument();
    expect(screen.queryByTestId("recipe-take-over")).not.toBeInTheDocument();
  });

  it("offers Take over only for the person's own lock", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(409, { error: "locked", heldByMe: true, member: null }))
      .mockResolvedValueOnce(jsonResponse(200, { revision: 3, expiresAt: "2026-10-27T12:02:00Z" }));
    renderWithQuery(
      <RecipeEditSession
        recipeId={RECIPE}
        homeId={null}
        revision={3}
        shared={false}
        initial={emptyRecipeForm()}
        members={[]}
      />,
    );
    await user.click(await screen.findByTestId("recipe-take-over"));
    expect(await screen.findByTestId("recipe-editor")).toBeInTheDocument();
    expect(sent(1).body).toMatchObject({ takeOver: true });
  });

  it("keeps the changes when the save finds the lock gone", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { revision: 3, expiresAt: "2026-10-27T12:02:00Z" }))
      .mockResolvedValueOnce(jsonResponse(409, { error: "lock-lost" }));
    renderWithQuery(
      <RecipeEditSession
        recipeId={RECIPE}
        homeId={null}
        revision={3}
        shared={false}
        initial={{ ...emptyRecipeForm(), name: "Soup", steps: [{ text: "Boil." }] }}
        members={[]}
      />,
    );
    const name = await screen.findByLabelText("Name");
    await user.type(name, " deluxe");
    await user.click(screen.getByTestId("recipe-save"));
    expect(await screen.findByTestId("recipe-lock-lapsed")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Soup deluxe");
    expect(sent(1).body).toMatchObject({ revision: 3, lockToken: sent(0).body.token });
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("cooking mode", () => {
  it("goes step by step and keeps progress in this tab only", async () => {
    const user = userEvent.setup();
    const { container, unmount } = renderWithQuery(
      <CookingMode recipe={detail()} homeId={HOME} initialServings={null} />,
    );
    expect(screen.getByTestId("cooking-step-count")).toHaveTextContent("Step 1 of 2");
    await user.click(screen.getByTestId("cooking-next"));
    expect(screen.getByTestId("cooking-step")).toHaveTextContent("Bake in a hot pan.");
    await user.click(screen.getByRole("checkbox", { name: /Flour/ }));
    expect(await axeViolations(container)).toEqual([]);
    unmount();
    renderWithQuery(<CookingMode recipe={detail()} homeId={HOME} initialServings={null} />);
    await waitFor(() => {
      expect(screen.getByTestId("cooking-step-count")).toHaveTextContent("Step 2 of 2");
    });
    expect(screen.getByRole("checkbox", { name: /Flour/ })).toBeChecked();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says when the recipe changed instead of swapping it silently", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, detail({ revision: 4 })));
    renderWithQuery(<CookingMode recipe={detail()} homeId={HOME} initialServings={null} />);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(
      await screen.findByText("This recipe was changed since you opened it."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("cooking-step")).toHaveTextContent("Mix everything.");
  });

  it("shows an unavailable state when access is gone", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: "not-found" }));
    renderWithQuery(<CookingMode recipe={detail()} homeId={HOME} initialServings={null} />);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByTestId("cooking-unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Mix everything.")).not.toBeInTheDocument();
  });

  it("explains when the screen cannot be kept on", async () => {
    const user = userEvent.setup();
    renderWithQuery(<CookingMode recipe={detail()} homeId={HOME} initialServings={null} />);
    await user.click(screen.getByRole("button", { name: "Keep screen on" }));
    expect(screen.getByText("This browser cannot keep the screen on.")).toBeInTheDocument();
  });
});
