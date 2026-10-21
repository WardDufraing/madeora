import { screen, within } from "@testing-library/react";
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

import type { CalendarEntry, TaskCalendar as CalendarData } from "@/tasks/api";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { TaskCalendar } from "./task-calendar";

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";
const TASK = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const OTHER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021";

interface State {
  calendar: { status: "ok"; value: CalendarData } | { status: "unavailable" };
  calls: { homeId: string | null; range: { from: string; to: string } }[];
  weekStart: "monday" | "sunday";
}
const state = vi.hoisted((): State => ({
  calendar: { status: "unavailable" },
  calls: [],
  weekStart: "monday",
}));

vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const { default: en } = await import("@/i18n/messages/en.json");
  return {
    getTranslations: (namespace: string) =>
      Promise.resolve(
        createTranslator({ locale: "en", messages: en, namespace: namespace as "Tasks" }),
      ),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/invitations/server", () => ({
  getDateTimeFormats: () =>
    Promise.resolve({
      timeZone: "Europe/Brussels",
      dateFormat: "ymd-dash",
      timeFormat: "24h",
      locale: "en",
    }),
}));
vi.mock("@/preferences/server", () => ({
  getRegionalFormats: () => Promise.resolve({ effective: { weekStart: state.weekStart } }),
}));
vi.mock("@/tasks/data", () => ({
  advanceSeries: () => Promise.resolve(),
  getTaskContext: () =>
    Promise.resolve({ status: "ok", value: { canManage: true, today: "2026-10-20" } }),
  listTaskLists: () =>
    Promise.resolve({
      status: "ok",
      value: [{ id: LIST, name: "Chores", archived: false, position: 0, revision: 1 }],
    }),
  listTaskLabels: () => Promise.resolve({ status: "ok", value: [] }),
  listTaskMembers: () =>
    Promise.resolve({ status: "ok", value: [{ id: "m1", name: "Sam", isSelf: false }] }),
  listTaskCalendar: (homeId: string | null, range: { from: string; to: string }) => {
    state.calls.push({ homeId, range: { from: range.from, to: range.to } });
    return Promise.resolve(state.calendar);
  },
}));

/** Runs the async server components of a tree, like the server render would. */
async function resolveTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((child) => resolveTree(child as ReactNode)));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === "function" && element.type.constructor.name === "AsyncFunction") {
    const render = element.type as (props: object) => Promise<ReactNode>;
    return resolveTree(await render(element.props));
  }
  const children = element.props.children;
  if (children === undefined) return element;
  const resolved = await Promise.all(Children.toArray(children).map((child) => resolveTree(child)));
  return cloneElement(element, {}, ...resolved);
}

function task(overrides: Partial<Extract<CalendarEntry, { kind: "task" }>> = {}): CalendarEntry {
  return {
    kind: "task",
    role: "due",
    date: "2026-10-20",
    taskId: TASK,
    listId: LIST,
    listName: "Chores",
    title: "Bins out",
    startDate: null,
    dueDate: "2026-10-20",
    priority: null,
    completed: false,
    overdue: false,
    recurring: true,
    needsReassignment: false,
    subtasksDone: 0,
    subtasksTotal: 0,
    labelIds: [],
    assigneeIds: [],
    canComplete: true,
    revision: 1,
    ...overrides,
  };
}

const planned: CalendarEntry = {
  kind: "planned",
  role: "due",
  date: "2026-10-27",
  taskId: TASK,
  listId: LIST,
  listName: "Chores",
  title: "Bins out",
  priority: null,
  recurring: true,
  needsReassignment: false,
  labelIds: [],
  assigneeIds: [],
};

async function show(searchParams: Record<string, string | string[]> = {}, home = true) {
  const tree = await resolveTree(
    <TaskCalendar home={home ? { id: HOME, name: "Thuis" } : null} searchParams={searchParams} />,
  );
  return renderWithQuery(<main>{tree}</main>).container;
}

beforeEach(() => {
  state.calls = [];
  state.weekStart = "monday";
  state.calendar = {
    status: "ok",
    value: {
      today: "2026-10-20",
      truncated: false,
      undated: 3,
      entries: [
        task(),
        task({
          taskId: OTHER,
          title: "Paint fence",
          role: "start",
          date: "2026-10-22",
          startDate: "2026-10-22",
          dueDate: "2026-11-02",
          recurring: false,
        }),
        task({
          taskId: OTHER,
          title: "Old chore",
          date: "2026-10-12",
          dueDate: "2026-10-12",
          overdue: true,
          recurring: false,
          canComplete: false,
        }),
        planned,
      ],
    },
  };
});

describe("TaskCalendar", () => {
  it("shows the month in whole weeks with today selected and its tasks completable", async () => {
    const container = await show();
    expect(state.calls).toEqual([
      { homeId: HOME, range: { from: "2026-09-28", to: "2026-11-01" } },
    ]);
    expect(screen.getByTestId("calendar-title")).toHaveTextContent("October 2026");
    expect(screen.getAllByTestId("calendar-day")).toHaveLength(35);
    const today = screen.getByRole("link", { name: /^2026-10-20, today, selected, 1 task$/ });
    expect(today).toHaveAttribute("aria-current", "date");
    const panel = screen.getByTestId("calendar-day-panel");
    expect(within(panel).getByRole("heading", { name: "Tasks on 2026-10-20" })).toBeInTheDocument();
    expect(within(panel).getByRole("checkbox", { name: /Bins out/ })).not.toBeChecked();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("labels start dates, overdue, repeats and planned dates in text", async () => {
    await show();
    const cell = (date: string) =>
      screen.getAllByTestId("calendar-day").find((td) => td.dataset.date === date);
    expect(cell("2026-10-22")).toHaveTextContent("Paint fence · Starts");
    expect(cell("2026-10-12")).toHaveTextContent("Old chore · Overdue");
    expect(cell("2026-10-20")).toHaveTextContent("Bins out · Repeats");
    expect(cell("2026-10-27")).toHaveTextContent("Bins out · Planned · Repeats");
  });

  it("lists a planned date in the day panel as not yet created, opening the series' task", async () => {
    await show({ day: "2026-10-27" });
    const panel = screen.getByTestId("calendar-day-panel");
    expect(within(panel).queryByRole("checkbox")).toBeNull();
    const planned = within(panel).getByTestId("calendar-day-planned");
    expect(within(planned).getByRole("link", { name: "Bins out" })).toHaveAttribute(
      "href",
      `/homes/${HOME}/tasks/${TASK}`,
    );
  });

  it("offers no completion for a task the viewer may not change", async () => {
    await show({ day: "2026-10-12" });
    const panel = screen.getByTestId("calendar-day-panel");
    expect(within(panel).getByRole("link", { name: "Old chore" })).toBeInTheDocument();
    expect(within(panel).queryByRole("checkbox")).toBeNull();
  });

  it("navigates by week with the person's first day and keeps the filters in the address", async () => {
    state.weekStart = "sunday";
    await show({ view: "week", date: "2026-10-21", status: "open" });
    expect(state.calls[0]?.range).toEqual({ from: "2026-10-18", to: "2026-10-24" });
    expect(screen.getByRole("link", { name: "Previous week" })).toHaveAttribute(
      "href",
      `/homes/${HOME}/tasks/calendar?view=week&date=2026-10-11&status=open`,
    );
    expect(screen.getByRole("link", { name: "Next week" })).toHaveAttribute(
      "href",
      `/homes/${HOME}/tasks/calendar?view=week&date=2026-10-25&status=open`,
    );
    expect(screen.getByRole("link", { name: "Week" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Calendar" })).toHaveAttribute("aria-current", "page");
  });

  it("offers small screens an agenda of the days with tasks, linking to each day", async () => {
    await show();
    const agenda = screen.getByTestId("calendar-agenda");
    const days = within(agenda).getAllByRole("link");
    expect(days.length).toBeGreaterThan(0);
    for (const day of days) expect(day.getAttribute("href")).toMatch(/day=\d{4}-\d{2}-\d{2}/);
    expect(agenda.querySelectorAll("ol > li")).toHaveLength(days.length);
  });

  it("links to the tasks without a due date instead of placing them", async () => {
    await show({ list: LIST });
    const undated = screen.getByTestId("calendar-undated");
    expect(undated).toHaveTextContent("3 tasks have no due date");
    expect(within(undated).getByRole("link", { name: "Show them in the list" })).toHaveAttribute(
      "href",
      `/homes/${HOME}/tasks?list=${LIST}&status=all&when=undated&hideFuture=0&assignee=any&sort=due`,
    );
  });

  it("says when the window holds more than it can show", async () => {
    if (state.calendar.status === "ok") {
      state.calendar = { status: "ok", value: { ...state.calendar.value, truncated: true } };
    }
    await show();
    expect(screen.getByText(/more tasks than the calendar can show/)).toHaveAttribute(
      "role",
      "status",
    );
  });

  it("shows an error, not an empty calendar, when the read fails", async () => {
    state.calendar = { status: "unavailable" };
    await show();
    expect(screen.getByText("The calendar could not be loaded")).toBeInTheDocument();
    expect(screen.queryByTestId("task-calendar")).toBeNull();
  });

  it("has no assignee filter in the Personal space", async () => {
    await show({}, false);
    expect(state.calls[0]?.homeId).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Assigned to" })).toBeNull();
  });
});
