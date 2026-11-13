import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { DisplayBoard } from "@/displays/board";
import { defaultDisplayLayout, defaultDisplayPreferences } from "@/displays/layout";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { DisplayConfigEditor, type DisplayConfigView } from "./display-config-editor";
import { DisplayScreen, IDLE_RESET_MS, OFFLINE_KEEP_MS } from "./display-screen";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

interface FakeRealtime {
  filters: unknown[];
  handler: ((payload: { new: Record<string, unknown> }) => void) | null;
  status: ((status: string) => void) | null;
  removed: number;
}
const realtime = vi.hoisted<FakeRealtime>(() => ({
  filters: [],
  handler: null,
  status: null,
  removed: 0,
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
  }),
}));

const fetchMock = vi.fn<typeof fetch>();
const replace = vi.fn();
const bodyOf = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown;
const answer = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const DISPLAY_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0071";
const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const BOB = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0011";
const ALICE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0012";
const OCCURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0031";

const base = {
  displayId: DISPLAY_ID,
  timeZone: "Europe/Brussels",
  preferences: defaultDisplayPreferences,
  signalVersion: 3,
};

const board: DisplayBoard = {
  ...base,
  locked: false,
  displayName: "Keuken",
  homeName: "Thuis",
  layout: defaultDisplayLayout,
  actions: true,
  requirePin: false,
  members: [
    {
      membershipId: BOB,
      name: "Bob",
      accentColor: null,
      isChild: false,
      hasPin: false,
      requiresPin: false,
    },
  ],
  lockManagers: [{ membershipId: ALICE, name: "Alice", accentColor: null }],
  chores: [
    {
      occurrenceId: OCCURRENCE,
      title: "Dishes",
      dueDate: "2026-11-13",
      overdue: false,
      assigneeIds: [],
      mandatoryOpen: 0,
      requiresApproval: false,
      requiresPin: false,
    },
  ],
  shopping: [
    {
      listId: LIST,
      name: "Groceries",
      remaining: 1,
      items: [
        {
          itemId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0041",
          name: "Milk",
          quantity: "2",
          unit: "l",
        },
      ],
    },
  ],
};

const locked: DisplayBoard = { ...base, locked: true, lockMessage: "Welkom!" };

beforeEach(() => {
  fetchMock.mockReset();
  replace.mockReset();
  realtime.filters = [];
  realtime.handler = null;
  realtime.status = null;
  realtime.removed = 0;
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { replace, origin: "http://app.test" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  router.refresh.mockClear();
});

describe("DisplayScreen", () => {
  it("shows the display's widgets with shared Home data only, accessibly", async () => {
    const { container } = renderWithQuery(<DisplayScreen initialBoard={board} />);
    expect(screen.getByRole("heading", { name: "Thuis" })).toBeInTheDocument();
    expect(screen.getByTestId("display-widget-clock")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Dishes/ })).toBeInTheDocument();
    expect(within(screen.getByTestId("display-shopping")).getByText("Milk")).toBeInTheDocument();
    expect(screen.getByText("Household Display: Keuken")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("subscribes to its own signal only and re-reads the board when it moves", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderWithQuery(<DisplayScreen initialBoard={board} />);
    expect(realtime.filters).toEqual([
      expect.objectContaining({
        table: "display_signals",
        filter: `display_id=eq.${DISPLAY_ID}`,
      }),
    ]);
    fetchMock.mockReturnValueOnce(answer(200, { board: { ...board, homeName: "Ons huis" } }));
    act(() => {
      realtime.handler?.({ new: { version: 4 } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/display/board");
    expect(await screen.findByRole("heading", { name: "Ons huis" })).toBeInTheDocument();
  });

  it("ignores a signal it has already shown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderWithQuery(<DisplayScreen initialBoard={board} />);
    act(() => {
      realtime.handler?.({ new: { version: 3 } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("switches to the lock screen without any household detail when it is locked remotely", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderWithQuery(<DisplayScreen initialBoard={board} />);
    fetchMock.mockReturnValueOnce(answer(200, { board: locked }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(await screen.findByTestId("display-locked")).toBeInTheDocument();
    expect(screen.getByText("Welkom!")).toBeInTheDocument();
    for (const text of ["Thuis", "Dishes", "Milk", "Bob", "Alice", "Keuken"]) {
      expect(screen.queryByText(text, { exact: false })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("has nothing that unlocks it on the screen itself", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQuery(<DisplayScreen initialBoard={locked} />);
    await user.click(screen.getByTestId("display-locked"));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("lets a manager lock it with their PIN", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockReturnValueOnce(answer(200, {}))
      .mockReturnValueOnce(answer(200, { board: locked }));
    renderWithQuery(<DisplayScreen initialBoard={board} />);
    await user.click(screen.getByRole("button", { name: "Privacy lock" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Alice" }));
    await user.type(within(dialog).getByLabelText("PIN of Alice"), "1234");
    await user.click(within(dialog).getByRole("button", { name: "Turn on privacy mode" }));
    await waitFor(() => {
      expect(screen.getByTestId("display-locked")).toBeInTheDocument();
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/display/lock");
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ membershipId: ALICE, pin: "1234" });
  });

  it("completes a chore for the member who did it on the display's own route", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockReturnValueOnce(
        answer(200, { outcome: "completed", actionId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0051" }),
      )
      .mockReturnValueOnce(answer(200, { board: { ...board, chores: [] } }));
    renderWithQuery(<DisplayScreen initialBoard={board} />);
    await user.click(screen.getByRole("button", { name: /Dishes/ }));
    await user.click(screen.getByRole("button", { name: "Bob" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/display/chores/complete");
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      occurrenceId: OCCURRENCE,
      membershipId: BOB,
      pin: null,
    });
    await waitFor(() => {
      expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/display/board");
    });
  });

  it("clears a member selection after a minute without a touch", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderWithQuery(<DisplayScreen initialBoard={board} />);
    await user.click(screen.getByRole("button", { name: /Dishes/ }));
    expect(screen.getByRole("button", { name: "Bob" })).toBeInTheDocument();
    fetchMock.mockReturnValue(answer(200, { board }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_RESET_MS + 100);
    });
    expect(screen.queryByRole("button", { name: "Bob" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Dishes/ })).toBeInTheDocument();
  });

  it("goes read-only offline, then shows only the time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockRejectedValue(new TypeError("offline"));
    renderWithQuery(<DisplayScreen initialBoard={board} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(await screen.findByText(/^Offline: showing the last known/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Dishes/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("display-chore-list")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Privacy lock" })).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OFFLINE_KEEP_MS);
    });
    expect(screen.getByTestId("display-offline")).toBeInTheDocument();
    expect(screen.queryByText("Thuis")).not.toBeInTheDocument();
    expect(screen.queryByText("Dishes")).not.toBeInTheDocument();
  });

  it("clears the screen and returns to pairing when the server no longer accepts it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock
      .mockReturnValueOnce(answer(401, { error: "not-paired" }))
      .mockReturnValueOnce(answer(200, {}));
    renderWithQuery(<DisplayScreen initialBoard={board} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/display");
    });
    expect(screen.queryByText("Thuis")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/display/reset");
  });
});

const config: DisplayConfigView = {
  layout: null,
  preferences: defaultDisplayPreferences,
  revision: 4,
  locked: false,
  lockMessage: null,
  applied: true,
  shoppingLists: [{ id: LIST, name: "Groceries" }],
};

describe("DisplayConfigEditor", () => {
  const render = (view: DisplayConfigView = config) =>
    renderWithQuery(
      <DisplayConfigEditor
        homeId={HOME_ID}
        displayId={DISPLAY_ID}
        displayName="Keuken"
        config={view}
      />,
    );

  it("shows the default layout, the lock and the presentation, accessibly", async () => {
    const { container } = render();
    expect(screen.getByText("Privacy mode is off.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "1. Clock" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "2. Chores" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "3. Shopping" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("moves, changes and saves against the loaded revision", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValueOnce(answer(200, { revision: 5 }));
    render();
    await user.click(screen.getByRole("button", { name: "Move Chores (position 2) up" }));
    expect(screen.getByRole("heading", { name: "1. Chores" })).toBeInTheDocument();
    await user.click(screen.getByLabelText("Members can complete chores here"));
    await user.selectOptions(screen.getByLabelText("Orientation"), "portrait");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/homes/${HOME_ID}/displays/${DISPLAY_ID}/config`,
    );
    const body = bodyOf(fetchMock.mock.calls[0]?.[1]) as {
      expectedRevision: number;
      layout: { widgets: { type: string; config: Record<string, unknown> }[] };
      preferences: { orientation: string };
    };
    expect(body.expectedRevision).toBe(4);
    expect(body.layout.widgets.map((widget) => widget.type)).toEqual([
      "chores",
      "clock",
      "shopping",
    ]);
    expect(body.layout.widgets[0]?.config["actions"]).toBe(false);
    expect(body.preferences.orientation).toBe("portrait");
    expect(await screen.findByText(/^Layout saved\./)).toBeInTheDocument();
  });

  it("reports a concurrent edit instead of overwriting it", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValueOnce(answer(409, { error: "conflict", revision: 6 }));
    render();
    await user.click(screen.getByRole("button", { name: "Remove Clock (position 1)" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/^Someone else changed this display/)).toBeInTheDocument();
  });

  it("warns about a chosen list that is gone", () => {
    render({
      ...config,
      layout: {
        version: 1,
        widgets: [
          {
            id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0091",
            type: "shopping",
            size: "medium",
            config: { listIds: ["6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0099"], count: 10 },
          },
        ],
      },
    });
    expect(screen.getByText(/A chosen shopping list is no longer available/)).toBeInTheDocument();
  });

  it("locks the display remotely with a welcome message", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValueOnce(answer(200, {}));
    render();
    await user.type(screen.getByLabelText("Welcome message (optional)"), "Welkom!");
    await user.click(screen.getByRole("button", { name: "Turn on privacy mode" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/homes/${HOME_ID}/displays/${DISPLAY_ID}/lock`,
    );
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ locked: true, message: "Welkom!" });
    expect(router.refresh).toHaveBeenCalled();
  });

  it("says when the display has not picked up the latest change", () => {
    render({ ...config, applied: false });
    expect(screen.getByTestId("display-config-applied")).toHaveTextContent(/^Not applied yet/);
  });
});
