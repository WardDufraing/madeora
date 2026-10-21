import { screen, within } from "@testing-library/react";
import { isValidElement, type ReactElement, type ReactNode } from "react";

import type { HomePermissionProjection } from "@madeora/domain/permissions";
import { addWidget, type DashboardLayout } from "@/dashboard/layout";
import { homeStarterLayout, personalStarterLayout } from "@/dashboard/starter";
import type { WidgetEntry } from "@/dashboard/view-types";
import type { DateTimeFormats } from "@/invitations/format";
import type { TaskRow } from "@/tasks/api";
import { defaultTaskQuery } from "@/tasks/filters";
import type { TaskWidgetConfig, TaskWidgetData } from "@/tasks/widget-data";
import type {
  ChoreApprovalsWidgetData,
  ChoreListConfig,
  ChoreWidgetData,
  ChoreWidgetRow,
} from "@/chores/widget-data";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { renderWidgets, type HomeScope, type PersonalScope } from "./widget-content";

interface State {
  locale: "en" | "nl";
  notifications: { status: "ok"; value: unknown[] } | { status: "unavailable" };
  directory:
    { status: "ok"; members: unknown[] } | { status: "not-found" } | { status: "unavailable" };
  tasks: TaskWidgetData | null;
  taskCalls: { homeId: string | null; config: TaskWidgetConfig }[];
  chores: ChoreWidgetData | null;
  approvals: ChoreApprovalsWidgetData;
  choreCalls: { homeId: string; kind: string; config: ChoreListConfig }[];
}
const state = vi.hoisted((): State => ({
  locale: "en",
  notifications: { status: "ok", value: [] },
  directory: { status: "ok", members: [] },
  tasks: null,
  taskCalls: [],
  chores: null,
  approvals: { status: "not-reviewer" },
  choreCalls: [],
}));

vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const { default: en } = await import("@/i18n/messages/en.json");
  const { default: nl } = await import("@/i18n/messages/nl.json");
  return {
    getLocale: () => Promise.resolve(state.locale),
    getTranslations: (namespace: string) =>
      Promise.resolve(
        createTranslator({
          locale: state.locale,
          messages: state.locale === "nl" ? nl : en,
          namespace: namespace as "Dashboard",
        }),
      ),
  };
});
vi.mock("@/notifications/server", () => ({
  listNotifications: () => Promise.resolve(state.notifications),
}));
vi.mock("@/members/directory", () => ({
  getHomeDirectory: () => Promise.resolve(state.directory),
}));
vi.mock("@/tasks/widget-data", () => ({
  loadTaskWidget: (homeId: string | null, config: TaskWidgetConfig) => {
    state.taskCalls.push({ homeId, config });
    return Promise.resolve(state.tasks ?? emptyTasks());
  },
}));
vi.mock("@/chores/widget-data", () => ({
  loadChoreWidget: (homeId: string, kind: string, config: ChoreListConfig) => {
    state.choreCalls.push({ homeId, kind, config });
    return Promise.resolve(state.chores ?? emptyChores());
  },
  loadChoreApprovalsWidget: () => Promise.resolve(state.approvals),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const noOptions = { lists: [], labels: [], members: [] };
const SELF = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0500";
const BEA = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0501";
const choreMembers = [
  { id: SELF, name: "Ann", isSelf: true },
  { id: BEA, name: "Bea", isSelf: false },
];
function emptyChores(): Extract<ChoreWidgetData, { status: "ok" }> {
  return {
    status: "ok",
    rows: [],
    total: 0,
    members: choreMembers,
    today: "2027-01-01",
    from: null,
    to: null,
    missingMember: false,
  };
}
function choreRow(overrides: Partial<ChoreWidgetRow> = {}): ChoreWidgetRow {
  return {
    id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0600",
    title: "Bins",
    category: null,
    dueDate: "2026-12-30",
    status: "open",
    overdue: true,
    inRework: false,
    requiresApproval: false,
    assigneeIds: [SELF],
    assignedToMe: true,
    mandatoryOpen: 0,
    completedAt: null,
    contributor: null,
    revision: 1,
    ...overrides,
  } as ChoreWidgetRow;
}
function emptyTasks(): TaskWidgetData {
  return {
    status: "ok",
    page: { tasks: [], total: 0 },
    list: null,
    options: noOptions,
    query: defaultTaskQuery,
    missingLabels: 0,
    missingMember: false,
    filtered: false,
  };
}
function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0300",
    listId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0400",
    listName: "Groceries",
    title: "Buy milk",
    startDate: null,
    dueDate: "2027-01-01",
    priority: "high",
    completed: false,
    needsReassignment: false,
    overdue: false,
    upcoming: false,
    subtasksDone: 0,
    subtasksTotal: 0,
    commentCount: 0,
    labelIds: [],
    assigneeIds: [],
    assignedToMe: false,
    canComplete: true,
    revision: 1,
    recurring: false,
    ...overrides,
  };
}

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const LEFT_HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0002";
const WIDGET_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0200";

const formats: DateTimeFormats = {
  timeZone: "Europe/Brussels",
  dateFormat: "ymd-dash",
  timeFormat: "24h",
  locale: "en",
};

function personalScope(overrides: Partial<PersonalScope> = {}): PersonalScope {
  return {
    kind: "personal",
    displayName: null,
    formats,
    timeZoneIsFallback: false,
    homes: [{ id: HOME_ID, name: "Thuis", timeZone: "UTC", role: "member" }],
    ...overrides,
  };
}

function homeScope(permissions: Partial<HomePermissionProjection> = {}): HomeScope {
  return {
    kind: "home",
    home: { id: HOME_ID, name: "Thuis", timeZone: "America/New_York" },
    permissions: { "home.invitations.manage": false, ...permissions } as HomePermissionProjection,
    formats,
  };
}

/** Widget bodies are async server components: run them, like the server render would. */
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === "function") {
    const render = element.type as (props: Record<string, unknown>) => unknown;
    const output = render(element.props);
    if (output instanceof Promise) return resolve((await output) as ReactNode);
  }
  return node;
}

async function show(entries: readonly WidgetEntry[]): Promise<HTMLElement> {
  const bodies = await Promise.all(entries.map((entry) => resolve(entry.body)));
  return renderWithQuery(
    <div>
      {entries.map((entry, index) => (
        <section key={entry.id} aria-label={entry.title}>
          {bodies[index]}
        </section>
      ))}
    </div>,
    state.locale,
  ).container;
}

function withHomeWidget(homeId: string): DashboardLayout {
  return addWidget(personalStarterLayout, {
    id: WIDGET_ID,
    type: "home-members",
    hidden: false,
    config: { showRoles: true },
    source: { homeId },
  });
}

beforeEach(() => {
  state.locale = "en";
  state.notifications = { status: "ok", value: [] };
  state.directory = { status: "ok", members: [] };
  state.tasks = null;
  state.taskCalls = [];
  state.chores = null;
  state.approvals = { status: "not-reviewer" };
  state.choreCalls = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  // 31 December 2026, 23:30 UTC: already 1 January 2027 in Brussels.
  vi.setSystemTime(new Date(Date.UTC(2026, 11, 31, 23, 30)));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("renderWidgets on the personal dashboard", () => {
  it("greets a new adult and shows today's date in their timezone and format", async () => {
    await show(await renderWidgets(personalStarterLayout, personalScope()));
    expect(screen.getByText("Welcome to Madeora")).toBeInTheDocument();
    const today = screen.getByTestId("today");
    expect(today).toHaveTextContent("Friday 2027-01-01");
    expect(today).toHaveAttribute("dateTime", "2027-01-01");
  });

  it("greets by display name, isolated so a right-to-left name cannot reorder the sentence", async () => {
    await show(await renderWidgets(personalStarterLayout, personalScope({ displayName: "שרה" })));
    expect(screen.getByText("Welcome, ⁨שרה⁩")).toBeInTheDocument();
  });

  it("says which timezone the date is in while the device has not reported one", async () => {
    await show(
      await renderWidgets(personalStarterLayout, personalScope({ timeZoneIsFallback: true })),
    );
    expect(
      screen.getByText(/\(in Europe\/Brussels, until this device reports its timezone\)/),
    ).toBeInTheDocument();
  });

  it("has truthful empty states and personal quick actions", async () => {
    await show(await renderWidgets(personalStarterLayout, personalScope()));
    const actions = screen.getByRole("region", { name: "Quick actions" });
    expect(within(actions).getByRole("link", { name: "Create a Home" })).toHaveAttribute(
      "href",
      "/homes/new",
    );
    expect(within(actions).getByRole("link", { name: "Trash" })).toHaveAttribute(
      "href",
      "/settings/trash",
    );
    const notifications = screen.getByRole("region", { name: "Notifications" });
    expect(within(notifications).getByText("No notifications")).toBeInTheDocument();
  });

  it("shows only as many notifications as the widget is set to", async () => {
    state.notifications = {
      status: "ok",
      value: Array.from({ length: 6 }, (_, index) => ({
        id: `n${String(index)}`,
        kind: "join_request.decided",
        homeId: null,
        homeName: null,
        objectionEndsAt: null,
        decision: "approved",
        duringQuietHours: false,
        createdAt: "2026-12-30T10:00:00Z",
        readAt: index === 0 ? null : "2026-12-30T11:00:00Z",
      })),
    };
    const layout: DashboardLayout = {
      ...personalStarterLayout,
      widgets: personalStarterLayout.widgets.map((w) =>
        w.type === "notifications" ? { ...w, config: { count: 3 } } : w,
      ),
    };
    await show(await renderWidgets(layout, personalScope()));
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(3);
    expect(within(region).getByText("Unread.")).toBeInTheDocument();
  });

  it("shows an error in one widget without breaking the others", async () => {
    state.notifications = { status: "unavailable" };
    await show(await renderWidgets(personalStarterLayout, personalScope()));
    expect(
      within(screen.getByRole("region", { name: "Notifications" })).getByText(
        "Couldn't load this widget",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Welcome to Madeora")).toBeInTheDocument();
  });

  it("labels a Home widget with its Home everywhere", async () => {
    state.directory = {
      status: "ok",
      members: [
        {
          membershipId: "m1",
          role: "owner",
          joinedAt: "2026-01-01T00:00:00Z",
          isSelf: true,
          name: "Sam",
          accentColor: null,
          avatarFileId: null,
        },
      ],
    };
    const entries = await renderWidgets(withHomeWidget(HOME_ID), personalScope());
    const entry = entries.find((e) => e.id === WIDGET_ID);
    expect(entry).toMatchObject({
      title: "Home members · ⁨Thuis⁩",
      sourceName: "Thuis",
      unavailable: false,
    });
    await show(entries);
    const region = screen.getByRole("region", { name: "Home members · ⁨Thuis⁩" });
    expect(within(region).getByText("⁨Sam⁩ (you)")).toBeInTheDocument();
    expect(within(region).getByText("Owner")).toBeInTheDocument();
  });

  it("shows a widget for a Home the person left as unavailable, without the Home's name or data", async () => {
    const entries = await renderWidgets(withHomeWidget(LEFT_HOME), personalScope());
    const entry = entries.find((e) => e.id === WIDGET_ID);
    expect(entry).toMatchObject({
      title: "Widget unavailable",
      sourceName: null,
      unavailable: true,
    });
    await show(entries);
    expect(screen.getAllByText("Widget unavailable").length).toBeGreaterThan(0);
  });
});

describe("renderWidgets on a Home dashboard", () => {
  it("welcomes to the Home with the Home's timezone", async () => {
    await show(await renderWidgets(homeStarterLayout, homeScope()));
    expect(screen.getByText("Welcome to ⁨Thuis⁩")).toBeInTheDocument();
    expect(screen.getByTestId("today")).toHaveAttribute("data-time-zone", "America/New_York");
    expect(screen.getByText(/the Home's timezone/)).toBeInTheDocument();
  });

  it("offers Invite people only to people who may manage invitations", async () => {
    await show(await renderWidgets(homeStarterLayout, homeScope()));
    expect(screen.queryByRole("link", { name: "Invite people" })).not.toBeInTheDocument();
  });

  it("links to invitations for invitation managers", async () => {
    await show(
      await renderWidgets(homeStarterLayout, homeScope({ "home.invitations.manage": true })),
    );
    expect(screen.getByRole("link", { name: "Invite people" })).toHaveAttribute(
      "href",
      `/homes/${HOME_ID}/invitations`,
    );
  });

  it("shows nothing of the Home when its directory cannot be read", async () => {
    state.directory = { status: "not-found" };
    await show(await renderWidgets(homeStarterLayout, homeScope()));
    expect(
      within(screen.getByRole("region", { name: "Home members" })).getByText(
        "Couldn't load this widget",
      ),
    ).toBeInTheDocument();
  });
});

const TASKS_WIDGET = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0201";
function withTasksWidget(
  layout: DashboardLayout,
  config: Partial<TaskWidgetConfig> = {},
  homeId?: string,
): DashboardLayout {
  return addWidget(
    { ...layout, widgets: layout.widgets.filter((w) => w.type !== "tasks") },
    {
      id: TASKS_WIDGET,
      type: "tasks",
      hidden: false,
      config,
      ...(homeId ? { source: { homeId } } : {}),
    },
  );
}

describe("tasks widgets", () => {
  it("shows personal tasks on the starter dashboard with a truthful empty state", async () => {
    await show(await renderWidgets(personalStarterLayout, personalScope()));
    const region = screen.getByRole("region", { name: "Personal tasks" });
    expect(within(region).getByText("No open tasks")).toBeInTheDocument();
    expect(within(region).getByText("All Tasks · No filters")).toBeInTheDocument();
    expect(state.taskCalls[0]?.homeId).toBeNull();
  });

  it("lists tasks with a completion box, the list name for All Tasks, and an accessible link", async () => {
    state.tasks = { ...emptyTasks(), page: { tasks: [taskRow()], total: 7 } } as TaskWidgetData;
    const container = await show(await renderWidgets(personalStarterLayout, personalScope()));
    const region = screen.getByRole("region", { name: "Personal tasks" });
    expect(within(region).getByRole("checkbox", { name: /Buy milk/ })).not.toBeChecked();
    expect(within(region).getByRole("link", { name: "Buy milk" })).toHaveAttribute(
      "href",
      "/tasks/6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0300",
    );
    expect(within(region).getByText(/Groceries/)).toBeInTheDocument();
    expect(within(region).getByText("Showing 1 of 7")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows no completion box for a task the viewer may not complete", async () => {
    state.tasks = {
      ...emptyTasks(),
      page: { tasks: [taskRow({ canComplete: false })], total: 1 },
    } as TaskWidgetData;
    await show(await renderWidgets(personalStarterLayout, personalScope()));
    const region = screen.getByRole("region", { name: "Personal tasks" });
    expect(within(region).queryByRole("checkbox")).toBeNull();
  });

  it("says a chosen list is gone instead of showing another one", async () => {
    state.tasks = { status: "list-unavailable", options: noOptions };
    await show(await renderWidgets(personalStarterLayout, personalScope()));
    const region = screen.getByRole("region", { name: "Personal tasks" });
    expect(within(region).getByText("This list is no longer available")).toBeInTheDocument();
    expect(within(region).queryByRole("checkbox")).toBeNull();
  });

  it("shows an error state when tasks cannot be read", async () => {
    state.tasks = { status: "unavailable" };
    await show(await renderWidgets(personalStarterLayout, personalScope()));
    const region = screen.getByRole("region", { name: "Personal tasks" });
    expect(within(region).getByText("Tasks could not be loaded")).toBeInTheDocument();
  });

  it("names its filters and missing labels or members", async () => {
    state.tasks = {
      ...emptyTasks(),
      list: { id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0400", name: "Groceries" },
      missingLabels: 2,
      missingMember: true,
      filtered: true,
    } as TaskWidgetData;
    const layout = withTasksWidget(homeStarterLayout, {
      when: "due_today",
      priorities: ["urgent"],
      assignee: "member",
    });
    await show(await renderWidgets(layout, homeScope()));
    const region = screen.getByRole("region", { name: "Home tasks" });
    expect(within(region).getByTestId("task-widget-scope")).toHaveTextContent(
      "List: ⁨Groceries⁩ · Due today · Priority: Urgent · Assigned to A former member",
    );
    expect(
      within(region).getByText("2 chosen labels no longer exist and are left out."),
    ).toBeInTheDocument();
    expect(within(region).getByText(/no longer a member/)).toBeInTheDocument();
    expect(within(region).getByText("No tasks match")).toBeInTheDocument();
    expect(state.taskCalls[0]?.homeId).toBe(HOME_ID);
  });

  it("reads a Home-bound widget on the personal dashboard from that Home, labelled with it", async () => {
    const entries = await renderWidgets(
      withTasksWidget(personalStarterLayout, {}, HOME_ID),
      personalScope(),
    );
    expect(entries.find((e) => e.id === TASKS_WIDGET)).toMatchObject({
      title: "Home tasks · ⁨Thuis⁩",
      sourceName: "Thuis",
    });
    await show(entries);
    expect(state.taskCalls.map((call) => call.homeId)).toEqual([HOME_ID]);
  });

  it("never reads tasks of a Home the person left", async () => {
    const entries = await renderWidgets(
      withTasksWidget(personalStarterLayout, {}, LEFT_HOME),
      personalScope(),
    );
    expect(entries.find((e) => e.id === TASKS_WIDGET)).toMatchObject({ unavailable: true });
    await show(entries);
    expect(state.taskCalls).toEqual([]);
  });
});

const CHORE_WIDGET = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0202";
function withChoreWidget(
  type: "my-chores" | "home-chores" | "chore-approvals",
  config: Record<string, unknown> = {},
  layout: DashboardLayout = homeStarterLayout,
  homeId?: string,
): DashboardLayout {
  return addWidget(layout, {
    id: CHORE_WIDGET,
    type,
    hidden: false,
    config,
    ...(homeId ? { source: { homeId } } : {}),
  });
}

describe("chore widgets", () => {
  it("lists my chores with quick complete and names the state and order", async () => {
    state.chores = { ...emptyChores(), rows: [choreRow()], total: 3 };
    const container = await show(await renderWidgets(withChoreWidget("my-chores"), homeScope()));
    const region = screen.getByRole("region", { name: "My Chores" });
    expect(within(region).getByTestId("chore-widget-scope")).toHaveTextContent(
      "Outstanding · earliest due first",
    );
    expect(within(region).getByRole("link", { name: "Bins" })).toHaveAttribute(
      "href",
      `/homes/${HOME_ID}/chores/6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0600`,
    );
    expect(within(region).getByText(/Overdue since/)).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: /Bins/ })).toBeInTheDocument();
    expect(within(region).getByText("Showing 1 of 3")).toBeInTheDocument();
    expect(state.choreCalls[0]).toMatchObject({ homeId: HOME_ID, kind: "my-chores" });
    expect(await axeViolations(container)).toEqual([]);
  });

  it("offers no quick complete for another member's chore or one with required steps", async () => {
    state.chores = {
      ...emptyChores(),
      rows: [
        choreRow({ assigneeIds: [BEA], assignedToMe: false }),
        choreRow({ id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0601", title: "Floor", mandatoryOpen: 1 }),
      ],
      total: 2,
    };
    await show(
      await renderWidgets(withChoreWidget("home-chores", { assignee: "any" }), homeScope()),
    );
    const region = screen.getByRole("region", { name: "All Home Chores" });
    expect(within(region).queryByRole("button")).toBeNull();
    expect(within(region).getByText(/Bea/)).toBeInTheDocument();
  });

  it("names a date range and a member who left", async () => {
    state.chores = {
      ...emptyChores(),
      from: "2027-01-01",
      to: "2027-01-07",
      missingMember: true,
    };
    await show(
      await renderWidgets(
        withChoreWidget("home-chores", { range: "next_7_days", assignee: "member", memberId: BEA }),
        homeScope(),
      ),
    );
    const region = screen.getByRole("region", { name: "All Home Chores" });
    expect(within(region).getByTestId("chore-widget-scope")).toHaveTextContent(
      "Outstanding · due 2027-01-01 to 2027-01-07 · Assigned to",
    );
    expect(within(region).getByText(/no longer in the Home/)).toBeInTheDocument();
    expect(within(region).getByText("Nothing here")).toBeInTheDocument();
  });

  it("shows Pending Approvals only to reviewers, without titles or counts for others", async () => {
    await show(await renderWidgets(withChoreWidget("chore-approvals"), homeScope()));
    const region = screen.getByRole("region", { name: "Pending Approvals" });
    expect(within(region).getByText("For chore reviewers")).toBeInTheDocument();
    expect(within(region).queryByRole("button")).toBeNull();
  });

  it("lets a reviewer approve or reject from the widget", async () => {
    state.approvals = {
      status: "ok",
      total: 1,
      members: choreMembers,
      approvals: [
        {
          occurrenceId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0600",
          choreId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0610",
          title: "Windows",
          category: null,
          scheduledDate: "2026-12-30",
          dueDate: "2026-12-30",
          late: true,
          assigneeIds: [BEA],
          submissionId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0620",
          attempt: 1,
          submittedAt: "2026-12-31T10:00:00Z",
          submittedBy: { me: false, member: BEA },
          contributor: { me: false, member: BEA },
          contributorCurrent: true,
          note: null,
          stepsDone: 0,
          stepsTotal: 0,
          revision: 4,
        },
      ],
    };
    const container = await show(
      await renderWidgets(withChoreWidget("chore-approvals"), homeScope()),
    );
    const region = screen.getByRole("region", { name: "Pending Approvals" });
    expect(within(region).getByRole("button", { name: "Approve Windows" })).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Reject Windows" })).toBeInTheDocument();
    expect(within(region).getByText(/submitted by .*Bea/)).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("never reads chores of a Home the person left", async () => {
    const entries = await renderWidgets(
      withChoreWidget("my-chores", {}, personalStarterLayout, LEFT_HOME),
      personalScope(),
    );
    expect(entries.find((e) => e.id === CHORE_WIDGET)).toMatchObject({ unavailable: true });
    await show(entries);
    expect(state.choreCalls).toEqual([]);
  });
});
