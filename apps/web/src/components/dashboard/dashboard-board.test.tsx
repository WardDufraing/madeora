import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Link from "next/link";
import type { Mock } from "vitest";

import type { DashboardLayout } from "@/dashboard/layout";
import { homeStarterLayout, personalStarterLayout } from "@/dashboard/starter";
import type { WidgetEntry } from "@/dashboard/view-types";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { DashboardBoard } from "./dashboard-board";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const fetchMock: Mock<typeof fetch> = vi.fn();

function entriesFor(layout: DashboardLayout): WidgetEntry[] {
  const titles: Record<string, string> = {
    welcome: "Welcome",
    "quick-actions": "Quick actions",
    notifications: "Notifications",
    "home-members": "Home members",
    tasks: "Personal tasks",
  };
  return layout.widgets.map((widget) => ({
    id: widget.id,
    title: titles[widget.type] ?? widget.type,
    sourceName: null,
    body: <Link href="/somewhere">{`Content of ${widget.type}`}</Link>,
    unavailable: false,
  }));
}

function renderBoard(overrides: Partial<Parameters<typeof DashboardBoard>[0]> = {}) {
  const layout = overrides.layout ?? personalStarterLayout;
  return renderWithQuery(
    <DashboardBoard
      target={{ kind: "personal" }}
      layout={layout}
      revision={0}
      canEdit
      canUndo={false}
      dropped={false}
      widgets={entriesFor(layout)}
      sourceHomes={[{ id: HOME_ID, name: "Thuis" }]}
      emptyState={<p>Nothing to show</p>}
      {...overrides}
    />,
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The templates edit mode loads (GET); answers for the mutations are queued with `answer`. */
let templateList: unknown[] = [];
let queued: Response[] = [];
function answer(status: number, body: unknown) {
  queued.push(jsonResponse(status, body));
}

/** The requests that change something, in order (edit mode's template list is left out). */
function mutations() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method !== undefined);
}

function sentBody(call = 0): Record<string, unknown> {
  const init = mutations()[call]?.[1];
  return JSON.parse(init?.body as string) as Record<string, unknown>;
}

beforeEach(() => {
  refresh.mockReset();
  fetchMock.mockReset();
  templateList = [];
  queued = [];
  fetchMock.mockImplementation((_url, init) =>
    Promise.resolve(
      init?.method === undefined
        ? jsonResponse(200, { templates: templateList })
        : (queued.shift() ?? jsonResponse(500, { error: "failed" })),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function openEditor() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Customize" }));
  await screen.findByTestId("dashboard-editor");
  return user;
}

describe("DashboardBoard in normal use", () => {
  it("shows the widgets in phone reading order, with working content and no edit controls", () => {
    renderBoard({ canEdit: false });
    const items = screen.getAllByTestId("dashboard-widget");
    expect(items.map((item) => item.getAttribute("data-widget-id"))).toEqual(
      personalStarterLayout.widgets.map((w) => w.id),
    );
    expect(screen.getByRole("link", { name: "Content of welcome" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Customize" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-arrange")).not.toBeInTheDocument();
  });

  it("leaves hidden widgets out", () => {
    const layout: DashboardLayout = {
      ...personalStarterLayout,
      widgets: personalStarterLayout.widgets.map((w) =>
        w.type === "welcome" ? { ...w, hidden: true } : w,
      ),
    };
    renderBoard({ layout });
    expect(screen.queryByRole("region", { name: "Welcome" })).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Quick actions" })).toBeInTheDocument();
  });

  it("shows the empty state when nothing is visible", () => {
    renderBoard({
      layout: { version: 1, widgets: [], placements: { lg: [], md: [], sm: [] } },
    });
    expect(screen.getByText("Nothing to show")).toBeInTheDocument();
  });

  it("says when something stored could not be shown", () => {
    renderBoard({ dropped: true });
    expect(
      screen.getByText("Some widgets on this dashboard are no longer available and were left out."),
    ).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = renderBoard();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("DashboardBoard edit mode", () => {
  it("makes widget content inert and labels each widget's arrange handle", async () => {
    renderBoard();
    await openEditor();
    const handles = screen.getAllByRole("button", { name: /^Arrange / });
    expect(handles).toHaveLength(4);
    const link = screen.getByRole("link", { hidden: true, name: "Content of welcome" });
    expect(link.closest("[inert]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("moves a widget with the keyboard, announces it, and saves the new arrangement", async () => {
    renderBoard();
    const user = await openEditor();
    const handle = screen.getByRole("button", { name: "Arrange Quick actions" });
    handle.focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("status")).toHaveTextContent(/^Quick actions: row 1, column 1 of 1/);
    expect(handle).toHaveFocus();

    answer(200, { revision: 1 });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
    const body = sentBody();
    expect(body.expectedRevision).toBe(0);
    expect(body.target).toEqual({ kind: "personal" });
    const sm = (body.layout as DashboardLayout).placements.sm;
    const quick = personalStarterLayout.widgets[1]?.id;
    expect(sm.find((p) => p.id === quick)?.y).toBe(0);
    expect(mutations()[0]?.[0]).toBe("/api/v1/dashboard");
    expect(mutations()[0]?.[1]?.method).toBe("PUT");
  });

  it("resizes with Shift and arrow keys within the widget's limits", async () => {
    renderBoard();
    const user = await openEditor();
    screen.getByRole("button", { name: "Arrange Welcome" }).focus();
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(screen.getByRole("status")).toHaveTextContent("3 tall");
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(screen.getByRole("status")).toHaveTextContent("can't change size further");
  });

  it("selects a widget to change its settings, hide it or remove it", async () => {
    renderBoard();
    const user = await openEditor();
    await user.click(screen.getByRole("button", { name: "Arrange Notifications" }));
    const panel = screen.getByTestId("dashboard-selected");
    await user.selectOptions(within(panel).getByLabelText("Notifications to show"), "10");
    await user.click(within(panel).getByRole("button", { name: "Hide" }));
    expect(screen.getByRole("status")).toHaveTextContent("Notifications hidden");
    expect(screen.getByText("Hidden")).toBeInTheDocument();

    answer(200, { revision: 1 });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(mutations()).toHaveLength(1);
    });
    const saved = (sentBody().layout as DashboardLayout).widgets.find(
      (w) => w.type === "notifications",
    );
    expect(saved).toMatchObject({ hidden: true, config: { count: 10 } });
  });

  it("removes a widget everywhere", async () => {
    renderBoard();
    const user = await openEditor();
    await user.click(screen.getByRole("button", { name: "Arrange Welcome" }));
    await user.click(
      within(screen.getByTestId("dashboard-selected")).getByRole("button", { name: "Remove" }),
    );
    expect(screen.getAllByRole("button", { name: /^Arrange / })).toHaveLength(3);
    expect(screen.getByRole("status")).toHaveTextContent("Welcome removed.");
  });

  it("adds a Home widget bound to the chosen Home, labelled with it", async () => {
    renderBoard();
    const user = await openEditor();
    const catalogue = screen.getByTestId("dashboard-catalogue");
    expect(within(catalogue).getByText("Home members · ⁨Thuis⁩")).toBeInTheDocument();
    await user.click(within(catalogue).getByRole("button", { name: "Add Home members · ⁨Thuis⁩" }));
    expect(
      screen.getByRole("button", { name: "Arrange Home members · ⁨Thuis⁩" }),
    ).toBeInTheDocument();
    answer(200, { revision: 1 });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(mutations()).toHaveLength(1);
    });
    const added = (sentBody().layout as DashboardLayout).widgets.find(
      (w) => w.type === "home-members",
    );
    expect(added?.source).toEqual({ homeId: HOME_ID });
  });

  it("offers tasks both from the Personal space and from a chosen Home", async () => {
    renderBoard();
    await openEditor();
    const catalogue = screen.getByTestId("dashboard-catalogue");
    expect(within(catalogue).getByRole("button", { name: "Add Personal tasks" })).toBeEnabled();
    expect(within(catalogue).getByRole("button", { name: "Add Tasks · ⁨Thuis⁩" })).toBeEnabled();
  });

  it("explains that Home widgets need a Home when the person has none", async () => {
    renderBoard({ sourceHomes: [] });
    await openEditor();
    const catalogue = screen.getByTestId("dashboard-catalogue");
    // Home members, Tasks of a Home and the four chore widgets.
    expect(within(catalogue).getAllByText(/Join or create a Home/)).toHaveLength(6);
    expect(within(catalogue).getByRole("button", { name: "Add My Chores" })).toBeDisabled();
    expect(within(catalogue).getByRole("button", { name: "Add Home members" })).toBeDisabled();
    expect(within(catalogue).getByRole("button", { name: "Add Tasks" })).toBeDisabled();
    expect(within(catalogue).getByRole("button", { name: "Add Personal tasks" })).toBeEnabled();
  });

  it("offers only the widgets a Home dashboard may hold", async () => {
    renderBoard({
      target: { kind: "home", homeId: HOME_ID },
      layout: homeStarterLayout,
      widgets: entriesFor(homeStarterLayout),
      sourceHomes: [],
    });
    await openEditor();
    const catalogue = screen.getByTestId("dashboard-catalogue");
    expect(within(catalogue).queryByRole("button", { name: "Add Notifications" })).toBeNull();
    expect(within(catalogue).getByRole("button", { name: "Add Home members" })).toBeEnabled();
  });

  it("asks before discarding changes on Cancel", async () => {
    renderBoard();
    const user = await openEditor();
    screen.getByRole("button", { name: "Arrange Quick actions" }).focus();
    await user.keyboard("{ArrowUp}");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = screen.getByRole("dialog", { name: "Discard your changes?" });
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByTestId("dashboard-editor")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByTestId("dashboard-editor")).not.toBeInTheDocument();
    expect(mutations()).toHaveLength(0);
  });

  it("keeps the draft and offers the latest version after a conflict", async () => {
    renderBoard();
    const user = await openEditor();
    screen.getByRole("button", { name: "Arrange Quick actions" }).focus();
    await user.keyboard("{ArrowUp}");
    answer(409, { error: "conflict", revision: 3 });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed elsewhere/);
    expect(screen.getByTestId("dashboard-editor")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load the latest version" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("resets to the starter layout after confirming what it contains", async () => {
    renderBoard({ revision: 5 });
    const user = await openEditor();
    await user.click(screen.getByRole("button", { name: "Reset to starter layout" }));
    const dialog = screen.getByRole("dialog", { name: "Reset to the starter layout?" });
    expect(dialog).toHaveTextContent("Welcome, Quick actions, Notifications");
    expect(dialog).toHaveTextContent("You can undo this once afterwards.");
    answer(200, { revision: 6 });
    await user.click(within(dialog).getByRole("button", { name: "Reset layout" }));
    await waitFor(() => {
      expect(mutations()).toHaveLength(1);
    });
    expect(mutations()[0]?.[0]).toBe("/api/v1/dashboard/reset");
    expect(sentBody()).toEqual({ target: { kind: "personal" }, expectedRevision: 5 });
  });

  it("applies a template after warning about unsaved changes", async () => {
    renderBoard();
    const user = await openEditor();
    screen.getByRole("button", { name: "Arrange Quick actions" }).focus();
    await user.keyboard("{ArrowUp}");
    await user.click(screen.getByRole("button", { name: "Apply template" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Your unsaved changes will be discarded.");
    answer(200, { revision: 1, dropped: 0 });
    await user.click(within(dialog).getByRole("button", { name: "Apply template" }));
    await waitFor(() => {
      expect(mutations()).toHaveLength(1);
    });
    expect(sentBody()).toMatchObject({ template: { builtIn: "starter-personal" } });
  });

  it("saves the layout as a template only when there are no unsaved changes", async () => {
    renderBoard();
    const user = await openEditor();
    answer(201, { id: "t1", dropped: 0 });
    await user.type(screen.getByLabelText("Template name"), "Mornings");
    await user.click(screen.getByRole("button", { name: "Save as template" }));
    expect(await screen.findByText(/Saved as template/)).toBeInTheDocument();
    expect(sentBody()).toEqual({ name: "Mornings", from: { kind: "personal" } });

    screen.getByRole("button", { name: "Arrange Quick actions" }).focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("button", { name: "Save as template" })).toBeDisabled();
  });

  it("offers a Home dashboard editor their own Home templates and those shared into this Home only", async () => {
    templateList = [
      {
        id: "t-own",
        name: "Own board",
        kind: "home",
        isMine: true,
        sharedHomeIds: [],
        widgets: ["welcome"],
      },
      {
        id: "t-here",
        name: "Shared here",
        kind: "home",
        isMine: false,
        sharedHomeIds: [HOME_ID],
        widgets: ["home-members"],
      },
      {
        id: "t-elsewhere",
        name: "Elsewhere",
        kind: "home",
        isMine: false,
        sharedHomeIds: ["other"],
        widgets: [],
      },
      {
        id: "t-personal",
        name: "Personal one",
        kind: "personal",
        isMine: true,
        sharedHomeIds: [],
        widgets: [],
      },
    ];
    renderBoard({
      target: { kind: "home", homeId: HOME_ID },
      layout: homeStarterLayout,
      widgets: entriesFor(homeStarterLayout),
      sourceHomes: [],
    });
    await openEditor();
    const select = await screen.findByLabelText("Template");
    await waitFor(() => {
      expect(
        within(select)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["Starter layout", "Own board", "\u2068Shared here\u2069 (shared)"]);
    });
  });

  it("offers a template saved from edit mode at once, without reloading", async () => {
    renderBoard();
    const user = await openEditor();
    answer(201, { id: "t1", dropped: 0 });
    templateList = [
      {
        id: "t1",
        name: "Mornings",
        kind: "personal",
        isMine: true,
        sharedHomeIds: [],
        widgets: ["welcome"],
      },
    ];
    await user.type(screen.getByLabelText("Template name"), "Mornings");
    await user.click(screen.getByRole("button", { name: "Save as template" }));
    const select = screen.getByLabelText("Template");
    await waitFor(() => {
      expect(within(select).getByRole("option", { name: "Mornings" })).toBeInTheDocument();
    });
  });

  it("keeps keyboard focus on the dashboard after removing a widget and after leaving edit mode", async () => {
    renderBoard();
    const user = await openEditor();
    await user.click(screen.getByRole("button", { name: "Arrange Welcome" }));
    await user.click(
      within(screen.getByTestId("dashboard-selected")).getByRole("button", { name: "Remove" }),
    );
    expect(screen.getByRole("button", { name: "Arrange Quick actions" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("button", { name: "Customize" })).toHaveFocus();
  });

  it("moves focus to the catalogue when the last widget is removed", async () => {
    const layout: DashboardLayout = {
      version: 1,
      widgets: personalStarterLayout.widgets.slice(0, 1),
      placements: {
        lg: personalStarterLayout.placements.lg.slice(0, 1),
        md: personalStarterLayout.placements.md.slice(0, 1),
        sm: personalStarterLayout.placements.sm.slice(0, 1),
      },
    };
    renderBoard({ layout, widgets: entriesFor(layout) });
    const user = await openEditor();
    await user.click(screen.getByRole("button", { name: "Arrange Welcome" }));
    await user.click(
      within(screen.getByTestId("dashboard-selected")).getByRole("button", { name: "Remove" }),
    );
    expect(screen.getByRole("button", { name: "Add Welcome" })).toHaveFocus();
  });

  it("has no axe violations in edit mode", async () => {
    const { container } = renderBoard();
    await openEditor();
    expect(await axeViolations(container)).toEqual([]);
  });
});
