import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";

import { ToastProvider } from "@/components/ui/toast";
import type {
  MealCopyPreview,
  MealEntry,
  MealOccurrence,
  MealPlan,
  MealSeries,
  MealTransferPreview,
} from "@/meals/api";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { MealCopyWeek } from "./meal-copy-week";
import { MealPlanner } from "./meal-planner";
import { MealPrint } from "./meal-print";
import { MealSettings } from "./meal-settings";
import { MealShoppingTransfer } from "./meal-shopping-transfer";
import { MealWidgetBody } from "./meal-widget-body";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const BREAKFAST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0011";
const LUNCH = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0012";
const DINNER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0013";
const RECIPE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const ENTRY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0030";
const OTHER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0031";
const SERIES = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";
const RECURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0041";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0050";

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Answers by method and path; anything unexpected fails loudly. */
function answer(routes: Record<string, (body: Record<string, unknown>) => [number, unknown]>) {
  fetchMock.mockImplementation((url, init) => {
    const method = init?.method ?? "GET";
    const path = url.split("?")[0] ?? url;
    const route = routes[`${method} ${path}`];
    if (!route) return Promise.resolve(jsonResponse(500, { error: "failed" }));
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const [status, payload] = route(body);
    return Promise.resolve(jsonResponse(status, payload));
  });
}

function sentTo(method: string, path: string): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => (init?.method ?? "GET") === method && url.split("?")[0] === path)
    .map(([, init]) =>
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    );
}

function render(ui: ReactElement, locale: "en" | "nl" = "en") {
  return renderWithQuery(
    <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss">
      {ui}
    </ToastProvider>,
    locale,
  );
}

const slots = [
  { id: BREAKFAST, standardKey: "breakfast", name: null, position: 1, enabled: true, revision: 1 },
  { id: LUNCH, standardKey: "lunch", name: "Middag", position: 2, enabled: true, revision: 1 },
  { id: DINNER, standardKey: "dinner", name: null, position: 3, enabled: true, revision: 1 },
] as const;

const lasagne: MealEntry = {
  kind: "entry",
  id: ENTRY,
  revision: 2,
  origin: null,
  date: "2026-10-28",
  slotId: DINNER,
  type: "recipe",
  recipe: { id: RECIPE, name: "Lasagne", servings: 4 },
  title: null,
  notes: "Extra cheese",
  servings: 6,
};
const hidden: MealEntry = {
  ...lasagne,
  id: OTHER,
  date: "2026-10-29",
  recipe: null,
  notes: null,
  servings: null,
};
const pizza: MealOccurrence = {
  kind: "occurrence",
  recurrenceId: RECURRENCE,
  seriesId: SERIES,
  cadence: "weekly",
  seriesRevision: 3,
  date: "2026-10-30",
  slotId: DINNER,
  type: "custom",
  recipe: null,
  title: "Pizza",
  notes: null,
  servings: null,
};
const pizzaSeries: MealSeries = {
  id: SERIES,
  status: "active",
  revision: 3,
  endOn: null,
  recurrenceId: RECURRENCE,
  slotId: DINNER,
  slotEnabled: true,
  type: "custom",
  recipe: null,
  title: "Pizza",
  notes: null,
  servings: null,
  cadence: "weekly",
  weekdays: [5],
  startOn: "2026-10-02",
  segmentEndOn: null,
};

function plan(overrides: Partial<MealPlan> = {}): MealPlan {
  return {
    access: "edit",
    memberAccess: "edit",
    settingsRevision: 0,
    today: "2026-10-28",
    from: "2026-10-26",
    to: "2026-11-01",
    slots: [...slots],
    entries: [lasagne, hidden],
    occurrences: [pizza],
    series: [pizzaSeries],
    token: "plan-1",
    ...overrides,
  };
}

function renderPlanner(value: MealPlan = plan(), locale: "en" | "nl" = "en") {
  return render(
    <MealPlanner
      homeId={HOME}
      context="De Vos"
      initialPlan={value}
      view="week"
      date="2026-10-28"
      weekStart="monday"
    />,
    locale,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  router.refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MealPlanner", () => {
  it("shows the week by slot, telling recipe, custom, unavailable and repeating meals apart", async () => {
    const { container } = renderPlanner();
    const wednesday = screen.getByTestId("meal-day-2026-10-28");
    expect(within(wednesday).getByRole("heading", { name: /Wednesday.*Today/ })).toBeVisible();
    expect(within(wednesday).getByText("Breakfast")).toBeVisible();
    expect(within(wednesday).getByText("Middag")).toBeVisible();
    expect(
      within(wednesday).getByRole("button", { name: /Lasagne.*Recipe.*6 servings/ }),
    ).toBeVisible();
    expect(
      within(wednesday).getByRole("button", {
        name: "Add a meal to Breakfast on Wednesday, October 28, 2026",
      }),
    ).toBeVisible();
    const thursday = screen.getByTestId("meal-day-2026-10-29");
    expect(within(thursday).getByText("Recipe unavailable")).toBeVisible();
    const friday = screen.getByTestId("meal-day-2026-10-30");
    expect(
      within(friday).getByRole("button", { name: /Pizza.*Custom meal.*Repeating/ }),
    ).toBeVisible();
    expect(screen.getAllByTestId("meal-day-2026-10-26")).toHaveLength(1);
    expect(screen.getByText(/Every week|Weekly on Friday/)).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("flags two meals in one slot as an unresolved conflict", () => {
    renderPlanner(plan({ entries: [lasagne, { ...hidden, date: "2026-10-30" }] }));
    const friday = screen.getByTestId("meal-day-2026-10-30");
    expect(within(friday).getByTestId("meal-conflict")).toHaveTextContent(
      "Two meals in one slot: open them to choose which stays",
    );
  });

  it("plans a recipe for dinner with servings, under one client id", async () => {
    const user = userEvent.setup();
    answer({
      "GET /api/v1/meals/recipes": () => [
        200,
        { recipes: [{ id: RECIPE, name: "Lasagne", servings: 4 }] },
      ],
      "POST /api/v1/meals/entries": () => [201, { id: "x", revision: 1 }],
      "GET /api/v1/meals/plan": () => [200, { plan: plan() }],
    });
    renderPlanner(plan({ entries: [], occurrences: [] }));
    const thursday = screen.getByTestId("meal-day-2026-10-29");
    await user.click(within(thursday).getAllByTestId("meal-add")[2] as HTMLElement);
    const dialog = await screen.findByTestId("meal-dialog");
    await waitFor(() => {
      expect(within(dialog).getByRole("option", { name: "Lasagne" })).toBeInTheDocument();
    });
    await user.selectOptions(within(dialog).getByTestId("meal-recipe"), RECIPE);
    await user.type(within(dialog).getByTestId("meal-servings"), "6");
    await user.click(within(dialog).getByTestId("meal-save"));
    await screen.findAllByText("Meal saved");
    const [body] = sentTo("POST", "/api/v1/meals/entries");
    expect(body).toMatchObject({
      homeId: HOME,
      date: "2026-10-29",
      slotId: DINNER,
      recipeId: RECIPE,
      title: null,
      servings: 6,
      notes: null,
      replace: null,
    });
    expect(body?.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(router.refresh).toHaveBeenCalled();
  });

  it("shows what fills a taken slot and replaces it only when asked", async () => {
    const user = userEvent.setup();
    let calls = 0;
    answer({
      "GET /api/v1/meals/recipes": () => [200, { recipes: [] }],
      "POST /api/v1/meals/entries": () => {
        calls += 1;
        return calls === 1
          ? [409, { error: "occupied", occupied: { occupants: [lasagne], replaceKey: "key-1" } }]
          : [201, { id: "x", revision: 1 }];
      },
    });
    renderPlanner(plan({ entries: [], occurrences: [] }));
    await user.click(
      within(screen.getByTestId("meal-day-2026-10-28")).getAllByTestId(
        "meal-add",
      )[2] as HTMLElement,
    );
    const dialog = await screen.findByTestId("meal-dialog");
    await user.click(within(dialog).getByTestId("meal-kind-custom"));
    await user.type(within(dialog).getByTestId("meal-title"), "Soup");
    await user.click(within(dialog).getByTestId("meal-save"));
    const occupied = await within(dialog).findByTestId("meal-occupied");
    expect(within(occupied).getByText("Lasagne")).toBeVisible();
    await user.click(within(occupied).getByTestId("meal-replace"));
    await screen.findAllByText("Meal saved");
    const bodies = sentTo("POST", "/api/v1/meals/entries");
    expect(bodies[0]?.replace).toBeNull();
    expect(bodies[1]).toMatchObject({ title: "Soup", replace: "key-1" });
    expect(bodies[1]?.id).toBe(bodies[0]?.id);
  });

  it("refuses an empty custom title before sending", async () => {
    const user = userEvent.setup();
    answer({ "GET /api/v1/meals/recipes": () => [200, { recipes: [] }] });
    renderPlanner(plan({ entries: [], occurrences: [] }));
    await user.click(
      within(screen.getByTestId("meal-day-2026-10-28")).getAllByTestId(
        "meal-add",
      )[0] as HTMLElement,
    );
    const dialog = await screen.findByTestId("meal-dialog");
    await user.click(within(dialog).getByTestId("meal-kind-custom"));
    await user.click(within(dialog).getByTestId("meal-save"));
    expect(await within(dialog).findByText("Fill this in.")).toBeVisible();
    expect(sentTo("POST", "/api/v1/meals/entries")).toHaveLength(0);
  });

  it("edits only one occurrence of a repeating meal", async () => {
    const user = userEvent.setup();
    answer({
      "GET /api/v1/meals/recipes": () => [200, { recipes: [] }],
      [`PUT /api/v1/meals/occurrences/${RECURRENCE}/2026-10-30`]: () => [
        200,
        { id: "x", revision: 1 },
      ],
    });
    renderPlanner();
    await user.click(screen.getByRole("button", { name: /Pizza/ }));
    const dialog = await screen.findByTestId("meal-dialog");
    expect(within(dialog).getByRole("radio", { name: /Only this meal/ })).toBeChecked();
    const title = within(dialog).getByTestId("meal-title");
    await user.clear(title);
    await user.type(title, "Pasta");
    await user.click(within(dialog).getByTestId("meal-save"));
    await screen.findAllByText("Meal saved");
    const [body] = sentTo("PUT", `/api/v1/meals/occurrences/${RECURRENCE}/2026-10-30`);
    expect(body).toMatchObject({
      date: "2026-10-30",
      slotId: DINNER,
      title: "Pasta",
      recipeId: null,
    });
  });

  it("edits this and later occurrences after showing the collisions to decide", async () => {
    const user = userEvent.setup();
    answer({
      "GET /api/v1/meals/recipes": () => [200, { recipes: [] }],
      [`PATCH /api/v1/meals/series/${SERIES}`]: (body) =>
        body.action === "preview"
          ? [
              200,
              {
                preview: {
                  nextDates: ["2026-10-30", "2026-11-06"],
                  collisions: [{ date: "2026-11-06", occupants: [lasagne], replaceKey: "k" }],
                  token: "t-1",
                },
              },
            ]
          : [200, { id: SERIES, revision: 4 }],
    });
    renderPlanner();
    await user.click(screen.getByRole("button", { name: /Pizza/ }));
    const dialog = await screen.findByTestId("meal-dialog");
    await user.click(within(dialog).getByTestId("meal-scope-future"));
    await user.click(within(dialog).getByTestId("meal-save"));
    const collisions = await within(dialog).findByTestId("meal-collisions");
    expect(within(collisions).getByText(/On 1 day something is already planned/)).toBeVisible();
    await user.selectOptions(within(collisions).getByRole("combobox"), "replace");
    await user.click(within(collisions).getByTestId("meal-series-confirm"));
    await screen.findAllByText("Repeating meal saved");
    const [preview, save] = sentTo("PATCH", `/api/v1/meals/series/${SERIES}`);
    expect(preview).toMatchObject({
      action: "preview",
      homeId: HOME,
      from: "2026-10-30",
      cadence: "weekly",
      weekdays: [5],
    });
    expect(save).toMatchObject({
      action: "editFuture",
      revision: 3,
      from: "2026-10-30",
      title: "Pizza",
      token: "t-1",
      decisions: { "2026-11-06": "replace" },
    });
  });

  it("skips one occurrence with Undo", async () => {
    const user = userEvent.setup();
    answer({
      "GET /api/v1/meals/recipes": () => [200, { recipes: [] }],
      [`DELETE /api/v1/meals/occurrences/${RECURRENCE}/2026-10-30`]: () => [200, {}],
      [`POST /api/v1/meals/occurrences/${RECURRENCE}/2026-10-30/restore`]: () => [200, {}],
    });
    renderPlanner();
    await user.click(screen.getByRole("button", { name: /Pizza/ }));
    const dialog = await screen.findByTestId("meal-dialog");
    await user.click(within(dialog).getByTestId("meal-remove"));
    await user.click(within(dialog).getByTestId("meal-remove-confirm"));
    await screen.findAllByText("Meal skipped");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findAllByText("Restored");
    expect(
      sentTo("POST", `/api/v1/meals/occurrences/${RECURRENCE}/2026-10-30/restore`),
    ).toHaveLength(1);
  });

  it("shows a view-only plan without changes, and a hidden recipe without details", async () => {
    const user = userEvent.setup();
    renderPlanner(plan({ access: "view" }));
    expect(screen.queryByTestId("meal-add")).toBeNull();
    expect(screen.queryByTestId("meal-copy-link")).toBeNull();
    expect(screen.getByText("You can view this plan")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Recipe unavailable/ }));
    const dialog = await screen.findByTestId("meal-dialog");
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(within(dialog).getByText("Recipe unavailable")).toBeVisible();
    expect(within(dialog).queryByRole("link")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/recipes"),
      expect.anything(),
    );
  });

  it("speaks Dutch", () => {
    renderPlanner(plan(), "nl");
    expect(screen.getAllByText("Ontbijt")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Recept niet beschikbaar")[0]).toBeVisible();
    expect(screen.getByRole("heading", { name: "Herhalende maaltijden" })).toBeVisible();
  });
});

describe("MealSettings", () => {
  it("asks what disabling a slot affects, then disables it with that confirmation", async () => {
    const user = userEvent.setup();
    let calls = 0;
    answer({
      [`PATCH /api/v1/meals/slots/${DINNER}`]: () => {
        calls += 1;
        return calls === 1
          ? [
              409,
              {
                error: "impact-required",
                impact: { futureMeals: 2, pastMeals: 1, series: 1, token: "i-1" },
              },
            ]
          : [200, { id: DINNER, revision: 2 }];
      },
    });
    const { container } = render(
      <MealSettings homeId={HOME} context="De Vos" plan={plan({ access: "manage" })} />,
    );
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Disable Dinner" }));
    await user.click(await screen.findByTestId("meal-slot-disable-confirm"));
    expect(await screen.findByText("2 meals from today on")).toBeVisible();
    expect(screen.getByText("1 repeating meal")).toBeVisible();
    await user.click(screen.getByTestId("meal-slot-disable-confirm"));
    await screen.findAllByText("Dinner disabled");
    const bodies = sentTo("PATCH", `/api/v1/meals/slots/${DINNER}`);
    expect(bodies[0]).toMatchObject({ enabled: false, impactToken: null, name: null });
    expect(bodies[1]).toMatchObject({ enabled: false, impactToken: "i-1" });
  });

  it("shows members the slots without controls", () => {
    render(<MealSettings homeId={HOME} context="De Vos" plan={plan({ access: "edit" })} />);
    expect(screen.queryByRole("button", { name: /Disable/ })).toBeNull();
    expect(screen.getByText("Meal managers change the slots.")).toBeVisible();
    expect(screen.getByText("Home members plan meals.")).toBeVisible();
  });
});

describe("MealCopyWeek", () => {
  const copyPreview: MealCopyPreview = {
    token: "c-1",
    rows: [
      {
        key: `e:${ENTRY}`,
        sourceDate: "2026-10-28",
        date: "2026-11-04",
        slotId: DINNER,
        type: "recipe",
        recipe: { id: RECIPE, name: "Lasagne", servings: 4 },
        title: null,
        notes: null,
        servings: 6,
        repeating: false,
        status: "ok",
        occupants: [pizza],
        replaceKey: "k",
      },
      {
        key: `e:${OTHER}`,
        sourceDate: "2026-10-29",
        date: "2026-11-05",
        slotId: DINNER,
        type: "recipe",
        recipe: null,
        title: null,
        notes: null,
        servings: null,
        repeating: false,
        status: "unavailable",
        occupants: [],
        replaceKey: "",
      },
    ],
  };

  it("copies chosen meals, replacing only where asked, and never an unavailable recipe", async () => {
    const user = userEvent.setup();
    answer({
      "GET /api/v1/meals/copy-week": () => [200, { preview: copyPreview }],
      "POST /api/v1/meals/copy-week": () => [
        200,
        { results: [{ key: `e:${ENTRY}`, id: "x", outcome: "created" }] },
      ],
    });
    const { container } = render(
      <MealCopyWeek
        homeId={HOME}
        source="2026-10-26"
        destination="2026-11-02"
        weekStart="monday"
      />,
    );
    await screen.findByTestId("meal-copy-rows");
    expect(screen.getByText("Recipe unavailable: not copied")).toBeVisible();
    expect(screen.getByTestId("meal-copy-confirm")).toBeDisabled();
    expect(await axeViolations(container)).toEqual([]);
    await user.selectOptions(screen.getByTestId("meal-copy-choice"), "replace");
    await user.click(screen.getByTestId("meal-copy-confirm"));
    await screen.findAllByText("1 meal copied.");
    const [body] = sentTo("POST", "/api/v1/meals/copy-week");
    expect(body).toMatchObject({
      homeId: HOME,
      source: "2026-10-26",
      destination: "2026-11-02",
      token: "c-1",
    });
    expect(body?.rows).toEqual([
      { key: `e:${ENTRY}`, id: expect.any(String) as unknown, replace: true },
    ]);
  });
});

describe("MealShoppingTransfer", () => {
  const transferPreview: MealTransferPreview = {
    token: "x-1",
    lists: [{ id: LIST, name: "Groceries", position: 1 }],
    meals: [
      {
        key: `e:${ENTRY}`,
        date: "2026-10-28",
        slotId: DINNER,
        status: "included",
        title: null,
        servings: 6,
        recipe: {
          id: RECIPE,
          name: "Lasagne",
          servings: 4,
          ingredients: [
            {
              position: 1,
              name: "Tomatoes",
              quantityNum: 500,
              quantityDen: 1,
              unit: "g",
              note: null,
            },
            {
              position: 2,
              name: "Olive oil",
              quantityNum: 1,
              quantityDen: 3,
              unit: "tbsp",
              note: "good",
            },
          ],
        },
      },
      {
        key: `o:${RECURRENCE}:2026-10-30`,
        date: "2026-10-30",
        slotId: DINNER,
        status: "custom",
        title: "Pizza",
        servings: null,
        recipe: null,
      },
    ],
  };

  it("scales rows to the planned servings, lets the person leave rows out, and adds the rest", async () => {
    const user = userEvent.setup();
    answer({
      "GET /api/v1/meals/shopping-transfer": () => [200, { preview: transferPreview }],
      "POST /api/v1/meals/shopping-transfer": (body) => [
        200,
        {
          results: (body.items as { id: string }[]).map((item) => ({
            id: item.id,
            outcome: "duplicate",
          })),
        },
      ],
    });
    const { container } = render(
      <MealShoppingTransfer homeId={HOME} from="2026-10-26" to="2026-11-01" />,
    );
    const rows = await screen.findAllByTestId("meal-transfer-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByText(/for 6 servings/)).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByLabelText("Quantity")).toHaveValue("750");
    expect(within(rows[1] as HTMLElement).getByLabelText("Quantity")).toHaveValue("0.5");
    expect(within(rows[1] as HTMLElement).getByLabelText("Packaging")).toHaveValue("tbsp");
    expect(screen.getByText(/custom meal, no ingredients/)).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
    await user.click(within(rows[1] as HTMLElement).getByRole("checkbox"));
    await user.click(screen.getByTestId("meal-transfer-confirm"));
    const duplicates = await screen.findByTestId("meal-transfer-duplicates");
    const [first] = sentTo("POST", "/api/v1/meals/shopping-transfer");
    expect(first).toMatchObject({
      homeId: HOME,
      listId: LIST,
      token: "x-1",
      from: "2026-10-26",
      to: "2026-11-01",
    });
    expect(first?.items).toEqual([
      expect.objectContaining({
        name: "Tomatoes",
        quantity: "750",
        unit: "g",
        allowDuplicate: false,
      }),
    ]);
    await user.click(within(duplicates).getByRole("checkbox", { name: "Tomatoes" }));
    await user.click(within(duplicates).getByRole("button", { name: "Add 1 again" }));
    await waitFor(() => {
      expect(sentTo("POST", "/api/v1/meals/shopping-transfer")).toHaveLength(2);
    });
    const second = sentTo("POST", "/api/v1/meals/shopping-transfer")[1];
    expect(second?.id).toBe(first?.id);
    expect(second?.items).toEqual([
      expect.objectContaining({ name: "Tomatoes", allowDuplicate: true }),
    ]);
  });
});

describe("MealPrint", () => {
  it("hides notes until included and refuses to print a changed plan", async () => {
    const user = userEvent.setup();
    const print = vi.fn();
    vi.stubGlobal("print", print);
    answer({ "GET /api/v1/meals/plan": () => [200, { plan: plan({ token: "plan-2" }) }] });
    const { container } = render(<MealPrint homeId={HOME} context="De Vos" plan={plan()} />);
    expect(screen.queryByText("Extra cheese")).toBeNull();
    expect(screen.getByText(/Printouts can be seen by people outside Madeora/)).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByTestId("meal-print-notes"));
    expect(screen.getByText("Extra cheese")).toBeVisible();
    await user.click(screen.getByTestId("meal-print-confirm"));
    expect(await screen.findByText(/The plan changed since this preview/)).toBeVisible();
    expect(print).not.toHaveBeenCalled();
  });

  it("prints when the plan is unchanged", async () => {
    const user = userEvent.setup();
    const print = vi.fn();
    vi.stubGlobal("print", print);
    answer({ "GET /api/v1/meals/plan": () => [200, { plan: plan() }] });
    render(<MealPrint homeId={HOME} context="De Vos" plan={plan()} />);
    await user.click(screen.getByTestId("meal-print-confirm"));
    await waitFor(() => {
      expect(print).toHaveBeenCalledTimes(1);
    });
  });
});

describe("MealWidgetBody", () => {
  it("lists a compact week with +N more, and today's slots with Add", () => {
    const many = ["a", "b", "c", "d"].map((title, index) => ({
      ...lasagne,
      id: `6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a01${String(index).padStart(2, "0")}`,
      slotId: slots[index % 3]?.id ?? DINNER,
      date: "2026-10-27",
      type: "custom" as const,
      recipe: null,
      title,
      servings: null,
    }));
    const { unmount } = render(
      <MealWidgetBody
        homeId={null}
        initialPlan={plan({ entries: [...many, lasagne] })}
        mode="week"
      />,
    );
    expect(screen.getByText("+1 more")).toBeVisible();
    unmount();
    render(
      <MealWidgetBody
        homeId={null}
        initialPlan={plan({
          from: "2026-10-28",
          to: "2026-10-28",
          entries: [lasagne],
          occurrences: [],
        })}
        mode="today"
      />,
    );
    expect(screen.getByRole("button", { name: "Lasagne" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: /Add a meal to/ })).toHaveLength(2);
  });
});
