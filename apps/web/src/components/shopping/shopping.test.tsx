import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";

import { ToastProvider } from "@/components/ui/toast";
import type { WidgetConfigs } from "@/dashboard/widgets";
import type { ShoppingItem, ShoppingListDetail, ShoppingWidgetData } from "@/shopping/api";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { AddSeveral } from "./add-several";
import { QuickAdd } from "./quick-add";
import { ShoppingListView } from "./shopping-list-view";
import { ShoppingLive } from "./shopping-live";
import { ShoppingWidgetBody } from "./shopping-widget-body";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

interface FakeRealtime {
  handler: ((payload: { new: Record<string, unknown> }) => void) | null;
  status: ((status: string) => void) | null;
  version: number;
  removed: number;
  filters: unknown[];
}
const realtime = vi.hoisted((): FakeRealtime => ({
  handler: null,
  status: null,
  version: 0,
  removed: 0,
  filters: [],
}));
vi.mock("@/auth/supabase-browser", () => ({
  getSupabaseBrowserClient: () => ({
    channel: () => {
      const channel = {
        on: (_type: string, filter: unknown, handler: FakeRealtime["handler"]) => {
          realtime.filters.push(filter);
          realtime.handler = handler;
          return channel;
        },
        subscribe: (status: FakeRealtime["status"]) => {
          realtime.status = status;
          return channel;
        },
      };
      return channel;
    },
    removeChannel: () => {
      realtime.removed += 1;
      return Promise.resolve("ok");
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { version: realtime.version }, error: null }),
        }),
      }),
    }),
  }),
}));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";
const OTHER_LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0011";
const CATEGORY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0030";
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

function bodyText(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : "{}";
}

function render(ui: ReactElement, locale: "en" | "nl" = "en") {
  return renderWithQuery(
    <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss">
      {ui}
    </ToastProvider>,
    locale,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  router.refresh.mockReset();
  router.push.mockReset();
  realtime.handler = null;
  realtime.status = null;
  realtime.version = 0;
  realtime.removed = 0;
  realtime.filters = [];
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function item(overrides: Partial<ShoppingItem> & { id: string; name: string }): ShoppingItem {
  return {
    quantity: null,
    unit: null,
    packaging: null,
    notes: null,
    categoryId: null,
    position: 1,
    completedAt: null,
    completedBy: null,
    recurrenceId: null,
    occurrenceOn: null,
    revision: 1,
    createdAt: "2026-10-28T08:00:00Z",
    ...overrides,
  };
}

const MILK = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021";
const BREAD = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0022";
const SOAP = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0023";

function list(overrides: Partial<ShoppingListDetail> = {}): ShoppingListDetail {
  return {
    id: LIST,
    homeId: HOME,
    name: "Groceries",
    archived: false,
    memberAccess: "edit",
    access: "edit",
    revision: 1,
    createdByMe: false,
    categories: [{ id: CATEGORY, name: "Dairy", revision: 1 }],
    items: [
      item({ id: MILK, name: "Milk", quantity: "1.5", unit: "l", categoryId: CATEGORY }),
      item({ id: BREAD, name: "Bread", position: 2 }),
      item({
        id: SOAP,
        name: "Soap",
        completedAt: "2026-10-28T09:30:00Z",
        completedBy: { me: false, member: MEMBER },
      }),
    ],
    recurrences: [],
    destinations: [{ id: OTHER_LIST, name: "Pharmacy", position: 1 }],
    ...overrides,
  };
}

const formats = {
  timeZone: "UTC",
  dateFormat: "ymd-dash",
  timeFormat: "24h",
  locale: "en",
} as const;
const members = [
  { id: MEMBER, name: "Sam", isSelf: false },
  { id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0041", name: "Me", isSelf: true },
];

describe("a shopping list", () => {
  it("groups active items by category and shows who completed what", async () => {
    const { container } = render(
      <ShoppingListView
        list={list()}
        homeId={HOME}
        members={members}
        formats={formats}
        today="2026-10-28"
      />,
    );
    const groups = screen.getAllByTestId("shopping-active-items");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveTextContent("1.5 l Milk");
    expect(groups[1]).toHaveTextContent("Bread");
    expect(screen.getByText("Uncategorized")).toBeInTheDocument();
    expect(screen.getByTestId("shopping-completed")).toHaveTextContent("Soap");
    expect(screen.getByTestId("shopping-completed-by")).toHaveTextContent(
      "Completed by Sam · 2026-10-28 09:30",
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it("moves a checked item to Completed at once and sends set-to-state", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse(200, { outcome: "completed", completedAt: null, completedBy: null }),
    );
    render(
      <ShoppingListView
        list={list()}
        homeId={HOME}
        members={members}
        formats={formats}
        today="2026-10-28"
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Check off Bread" }));
    expect(within(screen.getByTestId("shopping-completed")).getByText("Bread")).toBeInTheDocument();
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(sent(0)).toEqual({
      url: `/api/v1/shopping/items/${BREAD}/completion`,
      method: "PUT",
      body: { completed: true, seenCompletedAt: null },
    });
  });

  it("takes a check-off back when it is refused", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(403, { error: "not-permitted" }));
    render(
      <ShoppingListView
        list={list()}
        homeId={HOME}
        members={members}
        formats={formats}
        today="2026-10-28"
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Check off Bread" }));
    expect(await screen.findByText("You may not do this on this list.")).toBeInTheDocument();
    expect(
      within(screen.getAllByTestId("shopping-active-items")[1] ?? document.body).getByText("Bread"),
    ).toBeInTheDocument();
  });

  it("reopens with the completion it saw", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse(200, { outcome: "reopened", completedAt: null, completedBy: null }),
    );
    render(
      <ShoppingListView
        list={list()}
        homeId={HOME}
        members={members}
        formats={formats}
        today="2026-10-28"
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Uncheck Soap" }));
    expect(sent(0).body).toEqual({ completed: false, seenCompletedAt: "2026-10-28T09:30:00Z" });
  });

  it("offers nothing that changes a view-only list, and only check-off on a check-only one", () => {
    const { unmount } = render(
      <ShoppingListView
        list={list({ access: "view", memberAccess: "view" })}
        homeId={HOME}
        members={members}
        formats={formats}
        today="2026-10-28"
      />,
    );
    expect(screen.queryByTestId("shopping-quick-add")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Check off Bread" })).toBeDisabled();
    expect(screen.queryByTestId("shopping-clear-completed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shopping-list-settings")).not.toBeInTheDocument();
    unmount();
    render(
      <ShoppingListView
        list={list({ access: "check", memberAccess: "check" })}
        homeId={HOME}
        members={members}
        formats={formats}
        today="2026-10-28"
      />,
    );
    expect(screen.getByRole("checkbox", { name: "Check off Bread" })).toBeEnabled();
    expect(screen.queryByTestId("shopping-quick-add")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move Bread up" })).not.toBeInTheDocument();
  });

  it("treats an archived list as read only, even for its managers' items", () => {
    render(
      <ShoppingListView
        list={list({ access: "manage", archived: true })}
        homeId={HOME}
        members={members}
        formats={formats}
        today="2026-10-28"
      />,
    );
    expect(screen.getByText(/This list is archived/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Check off Bread" })).toBeDisabled();
    expect(screen.queryByTestId("shopping-quick-add")).not.toBeInTheDocument();
    expect(screen.getByTestId("shopping-list-settings")).toBeInTheDocument();
  });

  it("clears exactly the completed items it showed", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse(200, { outcome: "cleared", cleared: 1, skipped: 0, entryId: null }),
    );
    render(
      <ShoppingListView
        list={list()}
        homeId={HOME}
        members={members}
        formats={formats}
        today="2026-10-28"
      />,
    );
    await user.click(screen.getByTestId("shopping-clear-completed"));
    expect(screen.getByRole("dialog", { name: "Clear 1 completed item?" })).toBeInTheDocument();
    await user.click(screen.getByTestId("shopping-clear-confirm"));
    await waitFor(() => {
      expect(sent(0)).toEqual({
        url: `/api/v1/shopping/lists/${LIST}/clear-completed`,
        method: "POST",
        body: { itemIds: [SOAP] },
      });
    });
  });

  it("shows quantities with the Dutch decimal comma, exactly as stored", () => {
    render(
      <ShoppingListView
        list={list()}
        homeId={HOME}
        members={members}
        formats={formats}
        today="2026-10-28"
      />,
      "nl",
    );
    expect(screen.getAllByTestId("shopping-active-items")[0]).toHaveTextContent("1,5 l Milk");
  });
});

describe("quick add", () => {
  it("asks before adding a duplicate, then sends the same id with allowDuplicate", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockImplementationOnce((_url, init) => {
        const body = JSON.parse(bodyText(init)) as { items: { id: string }[] };
        return Promise.resolve(
          jsonResponse(200, { results: [{ id: body.items[0]?.id, outcome: "duplicate" }] }),
        );
      })
      .mockImplementationOnce((_url, init) => {
        const body = JSON.parse(bodyText(init)) as { items: { id: string }[] };
        return Promise.resolve(
          jsonResponse(200, { results: [{ id: body.items[0]?.id, outcome: "created" }] }),
        );
      });
    const { container } = render(<QuickAdd listId={LIST} />);
    await user.type(screen.getByTestId("shopping-quick-add"), " Milk ");
    await user.click(screen.getByTestId("shopping-quick-add-submit"));
    expect(
      await screen.findByText("Milk is already on the list. Add it again as a separate item?"),
    ).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByTestId("shopping-add-anyway"));
    await waitFor(() => {
      expect(screen.getByTestId("shopping-quick-add")).toHaveValue("");
    });
    const first = sent(0).body.items as { id: string; name: string; allowDuplicate: boolean }[];
    const second = sent(1).body.items as { id: string; name: string; allowDuplicate: boolean }[];
    expect(first[0]).toMatchObject({ name: "Milk", allowDuplicate: false });
    expect(second[0]).toMatchObject({ name: "Milk", allowDuplicate: true, id: first[0]?.id });
  });

  it("keeps the item's id for Try again after a lost answer", async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValueOnce(new TypeError("offline")).mockImplementationOnce((_u, init) => {
      const body = JSON.parse(bodyText(init)) as { items: { id: string }[] };
      return Promise.resolve(
        jsonResponse(200, { results: [{ id: body.items[0]?.id, outcome: "exists" }] }),
      );
    });
    render(<QuickAdd listId={LIST} />);
    await user.type(screen.getByTestId("shopping-quick-add"), "Bread");
    await user.click(screen.getByTestId("shopping-quick-add-submit"));
    expect(await screen.findByText(/No connection. Nothing was saved./)).toBeInTheDocument();
    await user.click(screen.getByTestId("shopping-quick-add-submit"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const ids = [0, 1].map((call) => (sent(call).body.items as { id: string }[])[0]?.id);
    expect(ids[0]).toBe(ids[1]);
  });

  it("refuses an empty name without sending anything", async () => {
    const user = userEvent.setup();
    render(<QuickAdd listId={LIST} />);
    await user.click(screen.getByTestId("shopping-quick-add-submit"));
    expect(screen.getByText("Fill this in.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("add several", () => {
  it("reviews lines, flags doubtful ones and duplicates, and adds the rest", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((_url, init) => {
      const body = JSON.parse(bodyText(init)) as { items: { id: string }[] };
      return Promise.resolve(
        jsonResponse(200, {
          results: body.items.map((row) => ({ id: row.id, outcome: "created" })),
        }),
      );
    });
    const { container } = render(<AddSeveral listId={LIST} homeId={HOME} activeNames={["Melk"]} />);
    await user.type(
      screen.getByTestId("shopping-add-several-text"),
      "500 g pasta{enter}{enter}2-3 uien{enter}melk{enter}6 appels",
    );
    await user.click(screen.getByTestId("shopping-add-several-review"));
    const rows = screen.getAllByTestId("shopping-preview-row");
    expect(rows).toHaveLength(4);
    expect(within(rows[0] ?? document.body).getByLabelText("Name")).toHaveValue("pasta");
    expect(within(rows[0] ?? document.body).getByLabelText("Quantity")).toHaveValue("500");
    expect(within(rows[1] ?? document.body).getByText("Check this line.")).toBeInTheDocument();
    expect(
      within(rows[2] ?? document.body).getByTestId("shopping-preview-duplicate"),
    ).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);

    // A marked duplicate needs a choice first.
    await user.click(screen.getByTestId("shopping-add-several-commit"));
    expect(
      await screen.findByText("Choose Keep as separate item or Remove row for each marked row."),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(
      within(rows[2] ?? document.body).getByRole("button", { name: /Remove the row/ }),
    );
    await user.click(screen.getByTestId("shopping-add-several-commit"));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(`/homes/${HOME}/shopping/${LIST}`);
    });
    const items = sent(0).body.items as Record<string, unknown>[];
    expect(items.map((row) => [row.name, row.quantity, row.unit])).toEqual([
      ["pasta", "500", "g"],
      ["2-3 uien", null, null],
      ["appels", "6", null],
    ]);
  });

  it("keeps the rows that were not added, so a retry never adds a row twice", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementationOnce((_url, init) => {
      const body = JSON.parse(bodyText(init)) as { items: { id: string }[] };
      return Promise.resolve(
        jsonResponse(200, {
          results: [
            { id: body.items[0]?.id, outcome: "created" },
            { id: body.items[1]?.id, outcome: "duplicate" },
          ],
        }),
      );
    });
    render(<AddSeveral listId={LIST} homeId={null} activeNames={[]} />);
    await user.type(screen.getByTestId("shopping-add-several-text"), "kaas{enter}brood");
    await user.click(screen.getByTestId("shopping-add-several-review"));
    await user.click(screen.getByTestId("shopping-add-several-commit"));
    expect(await screen.findByText("1 item added. 1 row needs a look.")).toBeInTheDocument();
    const rows = screen.getAllByTestId("shopping-preview-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0] ?? document.body).getByLabelText("Name")).toHaveValue("brood");
    expect(screen.getByTestId("shopping-preview-duplicate")).toBeInTheDocument();
  });
});

describe("live updates", () => {
  it("re-reads when the context's signal moves past what is shown, and cleans up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { unmount } = render(<ShoppingLive contextId={HOME} version={3} />);
    expect(realtime.filters).toEqual([
      { event: "*", schema: "public", table: "shopping_signals", filter: `context_id=eq.${HOME}` },
    ]);
    act(() => {
      realtime.handler?.({ new: { version: 3 } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(router.refresh).not.toHaveBeenCalled();
    act(() => {
      realtime.handler?.({ new: { version: 4 } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(router.refresh).toHaveBeenCalledTimes(1);
    unmount();
    expect(realtime.removed).toBe(1);
  });

  it("catches a change missed before subscribing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    realtime.version = 6;
    render(<ShoppingLive contextId={HOME} version={5} />);
    act(() => {
      realtime.status?.("SUBSCRIBED");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("the shopping widget", () => {
  const config: WidgetConfigs["shopping"] = {
    listIds: [LIST, OTHER_LIST],
    count: 5,
    quickAddListId: OTHER_LIST,
  };
  const data: ShoppingWidgetData = {
    lists: [
      { id: LIST, name: "Groceries", position: 0, access: "check" },
      { id: OTHER_LIST, name: "Groceries", position: 1, access: "edit" },
    ],
    unavailable: 1,
    total: 3,
    items: [
      {
        id: MILK,
        listId: LIST,
        name: "Milk",
        quantity: "2",
        unit: "l",
        packaging: null,
        revision: 1,
      },
      {
        id: SOAP,
        listId: OTHER_LIST,
        name: "Soap",
        quantity: null,
        unit: null,
        packaging: null,
        revision: 1,
      },
    ],
  };

  it("labels each row with its list when combining, and says a list is gone", async () => {
    const { container } = render(
      <ShoppingWidgetBody
        userId="user-a"
        homeId={HOME}
        config={config}
        initial={data}
        contextId={HOME}
        version={1}
      />,
    );
    const sources = screen.getAllByTestId("shopping-widget-source");
    expect(sources.map((source) => source.textContent)).toEqual([
      "Groceries (list 1)",
      "Groceries (list 2)",
    ]);
    expect(screen.getByTestId("shopping-widget-unavailable")).toHaveTextContent(
      "A selected list is no longer available.",
    );
    expect(screen.getByText("and 1 more")).toBeInTheDocument();
    expect(screen.getByText("Quick add to Groceries")).toBeInTheDocument();
    expect(screen.getByTestId("shopping-quick-add")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("offers no quick add where the viewer may not add", () => {
    render(
      <ShoppingWidgetBody
        userId="user-a"
        homeId={HOME}
        config={{ ...config, quickAddListId: LIST }}
        initial={data}
        contextId={HOME}
        version={1}
      />,
    );
    expect(screen.queryByTestId("shopping-quick-add")).not.toBeInTheDocument();
  });
});
