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
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }) }));

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
    type: widget.type,
    href: widget.type === "tasks" ? "/tasks" : null,
    emptyState: "full",
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
/** What GET /api/v1/dashboard/draft answers (UX2b). */
let storedDraft: unknown = null;
/** What draft autosaves answer. */
let draftSaveStatus = 200;
function answer(status: number, body: unknown) {
  queued.push(jsonResponse(status, body));
}

function isDraftCall(url: unknown): boolean {
  return String(url).includes("/api/v1/dashboard/draft");
}

/**
 * The requests that change something, in order (edit mode's template list and the draft calls,
 * checked separately with `draftCalls`, are left out).
 */
function mutations() {
  return fetchMock.mock.calls.filter(
    ([url, init]) => init?.method !== undefined && !isDraftCall(url),
  );
}

/** Draft autosaves and discards (UX2b), in order. */
function draftCalls(method?: string) {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      isDraftCall(url) &&
      init?.method !== undefined &&
      (method === undefined || init.method === method),
  );
}

function sentBody(call = 0): Record<string, unknown> {
  const init = mutations()[call]?.[1];
  return JSON.parse(init?.body as string) as Record<string, unknown>;
}

beforeEach(() => {
  refresh.mockReset();
  push.mockReset();
  fetchMock.mockReset();
  templateList = [];
  queued = [];
  storedDraft = null;
  draftSaveStatus = 200;
  fetchMock.mockImplementation((url, init) => {
    if (isDraftCall(url)) {
      if (init?.method === undefined)
        return Promise.resolve(jsonResponse(200, { draft: storedDraft }));
      if (init.method === "PUT") {
        return Promise.resolve(
          draftSaveStatus === 200
            ? jsonResponse(200, { updatedAt: "2026-11-25T10:00:00Z" })
            : jsonResponse(draftSaveStatus, {
                error: draftSaveStatus === 403 ? "not-permitted" : "failed",
              }),
        );
      }
      return Promise.resolve(jsonResponse(200, { discarded: true }));
    }
    return Promise.resolve(
      init?.method === undefined
        ? jsonResponse(200, { templates: templateList })
        : (queued.shift() ?? jsonResponse(500, { error: "failed" })),
    );
  });
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

/** Opens the widget gallery (UX2b) and returns its full catalogue list. */
async function openGallery(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Add widget" }));
  return screen.findByTestId("dashboard-catalogue");
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
    expect(handles).toHaveLength(5);
    const link = screen.getByRole("link", { hidden: true, name: "Content of welcome" });
    expect(link.closest("[inert]")).not.toBeNull();
    expect(screen.getByTestId("dashboard-draft-status")).toHaveTextContent("No changes yet.");
  });

  it("moves a widget with the keyboard, announces it, and saves the new arrangement", async () => {
    renderBoard();
    const user = await openEditor();
    const handle = screen.getByRole("button", { name: "Arrange Quick actions" });
    handle.focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("status")).toHaveTextContent(/^Quick actions: row 1, column 1 of 1/);
    expect(handle).toHaveFocus();
    // The edit-mode order follows the screen: Quick actions is now first to read and tab to (S17-L6).
    expect(screen.getAllByTestId("dashboard-edit-widget")[0]?.getAttribute("data-widget-id")).toBe(
      personalStarterLayout.widgets[1]?.id,
    );

    // The same refusal twice is still a new message for screen readers (S17-L5).
    await user.keyboard("{ArrowUp}");
    const first = screen.getByRole("status").textContent;
    expect(first).toMatch(/can't move further/);
    await user.keyboard("{ArrowUp}");
    const second = screen.getByRole("status").textContent;
    expect(second).toMatch(/can't move further/);
    expect(second).not.toBe(first);

    answer(200, { revision: 1 });
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
    const body = sentBody();
    expect(body.expectedRevision).toBe(0);
    expect(body.target).toEqual({ kind: "personal" });
    // Done commits and drops the draft in the same transaction (UX2b).
    expect(body.commitDraft).toBe(true);
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
    await user.click(screen.getByRole("button", { name: "Done" }));
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
    expect(screen.getAllByRole("button", { name: /^Arrange / })).toHaveLength(4);
    expect(screen.getByRole("status")).toHaveTextContent("Welcome removed.");
  });

  it("adds a Home widget bound to the chosen Home, labelled with it", async () => {
    renderBoard();
    const user = await openEditor();
    const catalogue = await openGallery(user);
    expect(within(catalogue).getByText("Home members · ⁨Thuis⁩")).toBeInTheDocument();
    await user.click(within(catalogue).getByRole("button", { name: "Add Home members · ⁨Thuis⁩" }));
    expect(
      screen.getByRole("button", { name: "Arrange Home members · ⁨Thuis⁩" }),
    ).toBeInTheDocument();
    answer(200, { revision: 1 });
    await user.click(screen.getByRole("button", { name: "Done" }));
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
    const user = await openEditor();
    const catalogue = await openGallery(user);
    expect(within(catalogue).getByRole("button", { name: "Add Personal tasks" })).toBeEnabled();
    expect(within(catalogue).getByRole("button", { name: "Add Tasks · ⁨Thuis⁩" })).toBeEnabled();
  });

  it("shows a small decorative preview beside each widget in the picker (S17-L9)", async () => {
    renderBoard();
    const user = await openEditor();
    const catalogue = await openGallery(user);
    const items = within(catalogue).getAllByRole("listitem");
    for (const item of items) {
      const preview = item.querySelector("[data-testid^='widget-preview-']");
      expect(preview).not.toBeNull();
      expect(preview).toHaveAttribute("aria-hidden", "true");
    }
    expect(items.length).toBeGreaterThan(0);
  });

  it("explains that Home widgets need a Home when the person has none", async () => {
    renderBoard({ sourceHomes: [] });
    const user = await openEditor();
    const catalogue = await openGallery(user);
    // Home members, Tasks of a Home, the four chore widgets, Home vacation, the three points
    // widgets (S23), Recipes of a Home (S24), Shopping of a Home (S26), the Meal planner of a
    // Home (S27), Habits and Habit insights of a Home (S28), Habit progress of a Home (S29), and
    // Goals and Goal progress of a Home (S30), Pet care (S31), Upcoming events of a Home (S32), and
    // Photos of a Home (S36).
    expect(within(catalogue).getAllByText(/Join or create a Home/)).toHaveLength(21);
    // Never an action the person cannot perform (decision 7): the reason instead of Add.
    expect(within(catalogue).queryByRole("button", { name: "Add My Chores" })).toBeNull();
    expect(within(catalogue).queryByRole("button", { name: "Add Home members" })).toBeNull();
    expect(within(catalogue).queryByRole("button", { name: "Add Tasks" })).toBeNull();
    expect(within(catalogue).getByRole("button", { name: "Add Personal tasks" })).toBeEnabled();
  });

  it("offers only the widgets a Home dashboard may hold", async () => {
    renderBoard({
      target: { kind: "home", homeId: HOME_ID },
      layout: homeStarterLayout,
      widgets: entriesFor(homeStarterLayout),
      sourceHomes: [],
    });
    const user = await openEditor();
    const catalogue = await openGallery(user);
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
    // Cancel discards the server draft too (decision 6).
    await waitFor(() => {
      expect(draftCalls("DELETE")).toHaveLength(1);
    });
  });

  it("keeps the draft after a conflict on Done and lets the person discard it", async () => {
    renderBoard();
    const user = await openEditor();
    screen.getByRole("button", { name: "Arrange Quick actions" }).focus();
    await user.keyboard("{ArrowUp}");
    answer(409, { error: "conflict", revision: 3 });
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/saved elsewhere while you were/);
    expect(screen.getByTestId("dashboard-editor")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Discard my changes and load the latest" }),
    );
    expect(refresh).toHaveBeenCalled();
    await waitFor(() => {
      expect(draftCalls("DELETE")).toHaveLength(1);
    });
  });

  it("replaces the newer version only when the person keeps their draft after a conflict", async () => {
    renderBoard({ revision: 2 });
    const user = await openEditor();
    screen.getByRole("button", { name: "Arrange Quick actions" }).focus();
    await user.keyboard("{ArrowUp}");
    answer(409, { error: "conflict", revision: 3 });
    await user.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByRole("alert");
    answer(200, { revision: 4 });
    await user.click(screen.getByRole("button", { name: "Replace it with my version" }));
    await waitFor(() => {
      expect(mutations()).toHaveLength(2);
    });
    expect(sentBody(0)).toMatchObject({ expectedRevision: 2, commitDraft: true });
    expect(sentBody(1)).toMatchObject({ expectedRevision: 3, commitDraft: true });
    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
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

  it("moves focus to Add widget when the last widget is removed", async () => {
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
    expect(screen.getByRole("button", { name: "Add widget" })).toHaveFocus();
  });

  it("has no axe violations in edit mode", async () => {
    const { container } = renderBoard();
    await openEditor();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("DashboardBoard edit-mode drafts, gallery and list editing (UX2b)", () => {
  const welcomeOnly: DashboardLayout = {
    version: 1,
    widgets: personalStarterLayout.widgets.slice(0, 1),
    placements: {
      lg: personalStarterLayout.placements.lg.slice(0, 1),
      md: personalStarterLayout.placements.md.slice(0, 1),
      sm: personalStarterLayout.placements.sm.slice(0, 1),
    },
  };

  function draftOf(layout: DashboardLayout, baseRevision: number, currentRevision: number) {
    return {
      layout,
      baseRevision,
      currentRevision,
      updatedAt: "2026-11-24T09:30:00Z",
      expiresAt: "2026-12-24T09:30:00Z",
    };
  }

  it("autosaves changes as a draft and says so only once the server confirms", async () => {
    renderBoard({ revision: 4 });
    const user = await openEditor();
    expect(draftCalls("PUT")).toHaveLength(0);
    screen.getByRole("button", { name: "Arrange Quick actions" }).focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByTestId("dashboard-draft-status")).toHaveTextContent("Unsaved changes");
    await waitFor(
      () => {
        expect(screen.getByTestId("dashboard-draft-status")).toHaveTextContent("Draft saved");
      },
      { timeout: 3000 },
    );
    expect(draftCalls("PUT")).toHaveLength(1);
    const body = JSON.parse(draftCalls("PUT")[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ target: { kind: "personal" }, baseRevision: 4 });
    // The dashboard itself was not touched.
    expect(mutations()).toHaveLength(0);
  });

  it("says plainly when an autosave fails, and when no draft can be kept", async () => {
    draftSaveStatus = 500;
    renderBoard();
    const user = await openEditor();
    screen.getByRole("button", { name: "Arrange Quick actions" }).focus();
    await user.keyboard("{ArrowUp}");
    await waitFor(
      () => {
        expect(screen.getByTestId("dashboard-draft-status")).toHaveTextContent("Save failed");
      },
      { timeout: 3000 },
    );
    draftSaveStatus = 403;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(screen.getByTestId("dashboard-draft-status")).toHaveTextContent(
        /A draft can't be kept for you/,
      );
    });
  });

  it("offers to resume a stored draft, and Done commits it on the revision it started from", async () => {
    storedDraft = draftOf(welcomeOnly, 4, 4);
    renderBoard({ revision: 4 });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Customize" }));
    const dialog = await screen.findByRole("dialog", { name: "Resume your draft?" });
    expect(dialog).toHaveTextContent("didn't finish");
    expect(within(dialog).queryByTestId("dashboard-draft-conflict")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Resume draft" }));
    expect(await screen.findByTestId("dashboard-editor")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Arrange / })).toHaveLength(1);
    expect(screen.getByTestId("dashboard-draft-status")).toHaveTextContent("Draft saved");
    answer(200, { revision: 5 });
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(mutations()).toHaveLength(1);
    });
    expect(sentBody()).toMatchObject({ expectedRevision: 4, commitDraft: true });
    expect((sentBody().layout as DashboardLayout).widgets).toHaveLength(1);
  });

  it("warns when the dashboard was saved since the draft began, and resuming builds on the newer one", async () => {
    storedDraft = draftOf(welcomeOnly, 4, 6);
    renderBoard({ revision: 6 });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Customize" }));
    const dialog = await screen.findByRole("dialog", { name: "Resume your draft?" });
    expect(within(dialog).getByTestId("dashboard-draft-conflict")).toHaveTextContent(
      /replaces that newer version/,
    );
    await user.click(within(dialog).getByRole("button", { name: "Resume draft" }));
    answer(200, { revision: 7 });
    await user.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(mutations()).toHaveLength(1);
    });
    expect(sentBody()).toMatchObject({ expectedRevision: 6, commitDraft: true });
  });

  it("discards a stored draft and starts from the saved dashboard", async () => {
    storedDraft = draftOf(welcomeOnly, 4, 4);
    renderBoard({ revision: 4 });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Customize" }));
    const dialog = await screen.findByRole("dialog", { name: "Resume your draft?" });
    await user.click(within(dialog).getByRole("button", { name: "Discard draft" }));
    expect(await screen.findByTestId("dashboard-editor")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Arrange / })).toHaveLength(5);
    expect(draftCalls("DELETE")).toHaveLength(1);
  });

  it("steps back and forward through this session's changes", async () => {
    renderBoard();
    const user = await openEditor();
    const undo = screen.getByRole("button", { name: "Undo" });
    const redo = screen.getByRole("button", { name: "Redo" });
    expect(undo).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Arrange Welcome" }));
    await user.click(
      within(screen.getByTestId("dashboard-selected")).getByRole("button", { name: "Remove" }),
    );
    expect(screen.getAllByRole("button", { name: /^Arrange / })).toHaveLength(4);
    await user.click(undo);
    expect(screen.getAllByRole("button", { name: /^Arrange / })).toHaveLength(5);
    expect(redo).toBeEnabled();
    await user.click(redo);
    expect(screen.getAllByRole("button", { name: /^Arrange / })).toHaveLength(4);
  });

  it("searches and filters the gallery, recommends missing defaults, and offers single widgets once", async () => {
    renderBoard();
    const user = await openEditor();
    await openGallery(user);
    const gallery = screen.getByTestId("widget-gallery");
    const catalogue = within(gallery).getByTestId("dashboard-catalogue");
    // Quick actions has no settings, so a second copy would show the same thing.
    expect(within(catalogue).queryByRole("button", { name: "Add Quick actions" })).toBeNull();
    expect(
      within(catalogue).getAllByText("Already on this dashboard. This widget can be added once."),
    ).not.toHaveLength(0);
    // Everything from the starter is on the dashboard: nothing to recommend.
    expect(within(gallery).queryByTestId("gallery-recommended")).toBeNull();

    await user.type(within(gallery).getByLabelText("Search widgets"), "habit");
    const names = within(within(gallery).getByTestId("dashboard-catalogue"))
      .getAllByTestId("gallery-card")
      .map((card) => card.getAttribute("data-widget-type"));
    expect(new Set(names)).toEqual(new Set(["habits", "habit-insights", "habit-progress"]));

    await user.clear(within(gallery).getByLabelText("Search widgets"));
    await user.click(within(gallery).getByRole("button", { name: "Lifestyle" }));
    const lifestyle = within(within(gallery).getByTestId("dashboard-catalogue"))
      .getAllByTestId("gallery-card")
      .map((card) => card.getAttribute("data-widget-type"));
    expect(new Set(lifestyle)).toEqual(new Set(["recipes", "shopping", "pet-care", "photos"]));
  });

  it("recommends a default widget that was removed, and adds it with focus on it", async () => {
    renderBoard();
    const user = await openEditor();
    await user.click(screen.getByRole("button", { name: "Arrange Welcome" }));
    await user.click(
      within(screen.getByTestId("dashboard-selected")).getByRole("button", { name: "Remove" }),
    );
    await openGallery(user);
    const recommended = screen.getByTestId("gallery-recommended");
    await user.click(within(recommended).getByRole("button", { name: "Add Welcome" }));
    expect(screen.queryByRole("dialog", { name: "Add widget" })).toBeNull();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Arrange Welcome" })).toHaveFocus();
    });
  });

  it("arranges the phone layout as a list on the same draft, and applies named sizes", async () => {
    renderBoard();
    const user = await openEditor();
    await user.click(screen.getByRole("button", { name: "List" }));
    const rows = screen.getAllByTestId("dashboard-stack-row");
    expect(rows).toHaveLength(5);
    await user.click(screen.getByRole("button", { name: "Move up: Quick actions" }));
    const order = screen
      .getAllByTestId("dashboard-stack-row")
      .map((row) => row.getAttribute("data-widget-id"));
    expect(order[0]).toBe(personalStarterLayout.widgets[1]?.id);
    await user.selectOptions(screen.getByLabelText("Size of Notifications"), "large");

    answer(200, { revision: 1 });
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(mutations()).toHaveLength(1);
    });
    const saved = sentBody().layout as DashboardLayout;
    const quick = personalStarterLayout.widgets[1]?.id;
    expect(saved.placements.sm.find((p) => p.id === quick)?.y).toBe(0);
    // Only the phone arrangement changed (decision 25).
    expect(saved.placements.lg).toEqual(personalStarterLayout.placements.lg);
    expect(saved.placements.md).toEqual(personalStarterLayout.placements.md);
    const notifications = personalStarterLayout.widgets[2]?.id;
    expect(saved.placements.sm.find((p) => p.id === notifications)?.h).toBeGreaterThan(
      personalStarterLayout.placements.sm.find((p) => p.id === notifications)?.h ?? 0,
    );
  });

  it("has no axe violations with the gallery open", async () => {
    const { container } = renderBoard();
    const user = await openEditor();
    await openGallery(user);
    expect(await axeViolations(container.ownerDocument.body)).toEqual([]);
  });
});

describe("DashboardBoard widget menu and settings (UX2a)", () => {
  async function openMenu(widget: string) {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: `Actions for ${widget}` }));
    return user;
  }

  it("gives every widget one three-dot menu, with the actions that fit it", async () => {
    renderBoard();
    expect(screen.getAllByRole("button", { name: /^Actions for / })).toHaveLength(
      personalStarterLayout.widgets.length,
    );
    const user = await openMenu("Personal tasks");
    expect(screen.getByRole("menuitem", { name: "Open full view" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Refresh" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Customize dashboard" })).toBeInTheDocument();
    // Moving, resizing and removing live in edit mode only.
    expect(screen.queryByRole("menuitem", { name: /remove|resize|move/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Open full view" }));
    expect(push).toHaveBeenCalledWith("/tasks");
  });

  it("offers no settings or customize to someone who cannot edit, and no settings where none exist", async () => {
    renderBoard({ canEdit: false });
    await openMenu("Personal tasks");
    expect(screen.queryByRole("menuitem", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Customize dashboard" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Refresh" })).toBeInTheDocument();
  });

  it("has no Settings item for a widget with nothing to configure", async () => {
    renderBoard();
    await openMenu("Quick actions");
    expect(screen.queryByRole("menuitem", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("refreshes from the menu", async () => {
    renderBoard();
    const user = await openMenu("Welcome");
    await user.click(screen.getByRole("menuitem", { name: "Refresh" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("opens edit mode from Customize dashboard", async () => {
    renderBoard();
    const user = await openMenu("Welcome");
    await user.click(screen.getByRole("menuitem", { name: "Customize dashboard" }));
    expect(await screen.findByTestId("dashboard-editor")).toBeInTheDocument();
  });

  it("saves only the widget's settings and leaves every position as it was", async () => {
    renderBoard({ revision: 3 });
    const user = await openMenu("Notifications");
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Notifications settings" });
    const apply = within(dialog).getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();
    await user.selectOptions(
      within(dialog).getByLabelText("When there is nothing to show"),
      "hide",
    );
    answer(200, { revision: 4 });
    await user.click(apply);
    await waitFor(() => {
      expect(mutations()).toHaveLength(1);
    });
    const body = sentBody();
    expect(body.expectedRevision).toBe(3);
    const saved = body.layout as DashboardLayout;
    expect(saved.placements).toEqual(personalStarterLayout.placements);
    expect(saved.widgets.map((w) => w.id)).toEqual(personalStarterLayout.widgets.map((w) => w.id));
    expect(saved.widgets.find((w) => w.type === "notifications")?.config).toMatchObject({
      emptyState: "hide",
    });
    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
  });

  it("keeps the panel and the choices when applying fails", async () => {
    renderBoard();
    const user = await openMenu("Notifications");
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Notifications settings" });
    await user.selectOptions(
      within(dialog).getByLabelText("When there is nothing to show"),
      "compact",
    );
    answer(500, { error: "failed" });
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("When there is nothing to show")).toHaveValue("compact");
  });

  it("asks before discarding unapplied settings", async () => {
    renderBoard();
    const user = await openMenu("Notifications");
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Notifications settings" });
    await user.selectOptions(
      within(dialog).getByLabelText("When there is nothing to show"),
      "compact",
    );
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(within(dialog).getByText("Discard these changes?")).toBeInTheDocument();
  });

  it("marks a widget that hides when empty in edit mode", async () => {
    const layout: DashboardLayout = {
      ...personalStarterLayout,
      widgets: personalStarterLayout.widgets.map((w) =>
        w.type === "notifications" ? { ...w, config: { count: 5, emptyState: "hide" } } : w,
      ),
    };
    renderBoard({ layout, widgets: entriesFor(layout) });
    await openEditor();
    expect(screen.getAllByText("Hides when empty")).toHaveLength(1);
  });

  it("hides an empty widget that asked to be hidden, without touching the layout", () => {
    const widgets = entriesFor(personalStarterLayout).map((entry) =>
      entry.type === "notifications"
        ? { ...entry, body: <div data-widget-empty="hide">Nothing</div> }
        : entry,
    );
    renderBoard({ widgets });
    // The marker is what the grid hides on (CSS `:has`); the item and its place stay in the DOM.
    const item = screen
      .getAllByTestId("dashboard-widget")
      .find((el) => el.getAttribute("data-widget-id") === widgets[2]?.id);
    expect(item?.className).toContain("[&:has([data-widget-empty=hide])]:hidden");
  });

  it("has no axe violations with the menu open", async () => {
    const { container } = renderBoard();
    await openMenu("Welcome");
    expect(await axeViolations(container)).toEqual([]);
  });
});
