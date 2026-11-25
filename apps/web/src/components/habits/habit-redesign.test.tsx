// UX5: the daily list's summary, rows and week strip, the trends view and the progressive editor.
// What the database allows stays in the S28/S29 tests; these check what the interface shows.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ToastProvider } from "@/components/ui/toast";
import type { HabitCalendar, HabitDetail, HabitList } from "@/habits/api";
import {
  HABIT,
  habitCheckin,
  habitSummary,
  numericDay,
  numericHabitDetail,
  numericHabitSummary,
} from "@/habits/testing";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { combineDays, tallyMonth } from "./habit-trends";
import { summarizeToday } from "./habit-summary";
import { weekCells } from "./habit-week-strip";
import { HabitsView } from "./habits-view";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/habits" }));

const fetchMock = vi.fn<typeof fetch>();
const urlOf = (input: RequestInfo | URL | undefined): string =>
  input === undefined
    ? ""
    : typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
const reply = (body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

beforeEach(() => {
  fetchMock.mockReset();
  router.push.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function list(extra: Partial<HabitList> = {}): HabitList {
  return {
    habits: [habitSummary()],
    counts: { active: 1, ended: 0, archived: 0 },
    access: "manage",
    memberAccess: null,
    celebrations: true,
    timeZone: "Europe/Brussels",
    ...extra,
  };
}

function renderList(initial: HabitList) {
  return renderWithQuery(
    <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss">
      <HabitsView
        homeId={null}
        view="active"
        query=""
        initialList={initial}
        members={[]}
        today="2026-11-10"
        weekStart="monday"
        timeZone="Europe/Brussels"
        timeZones={["Europe/Brussels"]}
      />
    </ToastProvider>,
  );
}

const day = (onDate: string, state: HabitCalendar["days"][number]["state"]) => ({
  onDate,
  state,
  kind: "daily" as const,
  pausedBy: null,
});

describe("the daily summary", () => {
  it("counts the habits scheduled today and names the longest streak", () => {
    const done = habitSummary({
      id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0091",
      name: "Read",
      todayCheckin: habitCheckin(),
      streak: { current: 9, unit: "occurrences", longestOccurrences: 9, longestWeeks: 0 },
    });
    const resting = habitSummary({
      id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0092",
      name: "Swim",
      todayState: "not_scheduled",
    });
    const summary = summarizeToday([habitSummary(), done, resting]);
    expect(summary.total).toBe(2);
    expect(summary.done).toBe(1);
    expect(summary.best?.name).toBe("Read");
  });

  it("says so in words, and celebrates a finished day only when celebrations are on", () => {
    const finished = habitSummary({ todayCheckin: habitCheckin() });
    const { unmount } = renderList(list({ habits: [finished] }));
    expect(screen.getByTestId("habit-summary-today")).toHaveTextContent("1 of 1 done today");
    expect(screen.getByTestId("habit-summary-milestone")).toHaveTextContent("All done for today");
    unmount();
    renderList(list({ habits: [finished], celebrations: false }));
    expect(screen.getByTestId("habit-summary-milestone")).toBeEmptyDOMElement();
  });
});

describe("the habit rows", () => {
  it("completes with one tap on the circle and keeps the page where it is", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((input, init) =>
      init?.method === "POST"
        ? reply({ outcome: "completed", checkin: habitCheckin(), milestone: null })
        : reply({ list: list() }),
    );
    renderList(list());
    const check = screen.getByRole("button", { name: "Complete Morning walk for today" });
    await user.click(check);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => urlOf(url).endsWith(`/habits/${HABIT}/checkins`)),
      ).toBe(true);
    });
    expect(router.push).not.toHaveBeenCalled();
  });

  it("shows no completion control to a view-only member, only the state", () => {
    renderList(list({ habits: [habitSummary({ access: "view" })], access: "view" }));
    expect(screen.queryByTestId("habit-complete")).not.toBeInTheDocument();
    expect(screen.queryByTestId("habit-new")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("opens details and edit from the actions menu, and edit only for managers", async () => {
    const user = userEvent.setup();
    renderList(list());
    await user.click(screen.getByRole("button", { name: "Actions for Morning walk" }));
    expect(screen.getByRole("menuitem", { name: "Details" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(await screen.findByRole("dialog", { name: "Edit habit" })).toBeInTheDocument();
    expect(screen.getByTestId("habit-name")).toHaveValue("Morning walk");
  });

  it("shows a numeric habit's progress instead of a completion circle", () => {
    renderList(list({ habits: [numericHabitSummary()] }));
    expect(screen.queryByTestId("habit-complete")).not.toBeInTheDocument();
    expect(screen.getByTestId("habit-progress")).toBeInTheDocument();
  });

  it("shows an empty state with a New habit action for managers, without accessibility violations", async () => {
    const { container } = renderList(list({ habits: [] }));
    expect(screen.getByRole("button", { name: "New habit" })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("the week strip", () => {
  const habit = habitSummary();
  const recent = (entries: [string, HabitDetail["recent"][number]["state"]][]) =>
    entries.map(([onDate, state]) => ({ ...day(onDate, state), block: null, checkin: null }));

  it("gives seven days of the habit's week, with upcoming days never missed", () => {
    const cells = weekCells(habit, {
      recent: recent([
        ["2026-11-10", "pending"],
        ["2026-11-09", "completed"],
        ["2026-11-08", "missed"],
      ]),
      numericRecent: [],
    });
    expect(cells.map((cell) => cell.date)).toEqual([
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
    ]);
    expect(cells.map((cell) => cell.state)).toEqual([
      "completed",
      "pending",
      "future",
      "future",
      "future",
      "future",
      "future",
    ]);
  });

  it("marks a numeric day partial between nothing and its target, completed at it", () => {
    const cells = weekCells(habit, {
      recent: recent([
        ["2026-11-09", "completed"],
        ["2026-11-10", "pending"],
      ]),
      numericRecent: [
        numericDay({ onDate: "2026-11-09", total: 2000, met: true, above: false }),
        numericDay({ onDate: "2026-11-10", total: 500, met: false, above: false }),
      ],
    });
    expect(cells[0]).toMatchObject({ state: "completed", fraction: 1 });
    expect(cells[1]).toMatchObject({ state: "partial", fraction: 0.25 });
  });

  it("renders the strip with a text name for every day when the week view is on", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((input) =>
      urlOf(input).includes("/habits?")
        ? reply({ list: list() })
        : reply({
            habit: numericHabitDetail({
              id: HABIT,
              recent: recent([["2026-11-09", "completed"]]),
            }),
          }),
    );
    const { container } = renderList(list());
    await user.click(screen.getByTestId("habits-mode-week"));
    const strip = await screen.findByTestId("habit-week-strip");
    const cells = within(strip).getAllByTestId("habit-week-cell");
    expect(cells).toHaveLength(7);
    for (const cell of cells) expect(cell).toHaveAttribute("aria-label");
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("the trends view", () => {
  const calendar = (days: HabitCalendar["days"]): HabitCalendar => ({
    month: "2026-11-01",
    today: "2026-11-10",
    weekStart: "monday",
    days,
    weeks: [],
    numericDays: [],
  });

  it("combines habits into one cell per day without counting upcoming days against anyone", () => {
    const days = combineDays([
      calendar([
        day("2026-11-08", "completed"),
        day("2026-11-09", "missed"),
        day("2026-11-10", "pending"),
        day("2026-11-11", "future"),
        day("2026-11-07", "not_scheduled"),
      ]),
      calendar([day("2026-11-08", "missed"), day("2026-11-11", "future")]),
    ]);
    expect(days.get("2026-11-08")).toBe("partial");
    expect(days.get("2026-11-09")).toBe("missed");
    expect(days.get("2026-11-10")).toBe("pending");
    expect(days.get("2026-11-11")).toBe("future");
    expect(days.has("2026-11-07")).toBe(false);
  });

  it("tallies only finished scheduled days", () => {
    expect(
      tallyMonth(
        calendar([
          day("2026-11-08", "completed"),
          day("2026-11-09", "missed"),
          day("2026-11-10", "pending"),
          day("2026-11-11", "future"),
        ]),
      ),
    ).toEqual({ completed: 1, eligible: 2 });
  });

  it("opens from View trends, shows consistency and a calendar, and links to each habit", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((input) =>
      urlOf(input).includes("/calendar")
        ? reply({
            calendar: calendar([
              day("2026-11-08", "completed"),
              day("2026-11-09", "missed"),
              day("2026-11-10", "pending"),
            ]),
          })
        : reply({ list: list() }),
    );
    const { container } = renderList(list());
    await user.click(screen.getByTestId("habits-view-trends"));
    expect(await screen.findByText("50%")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 scheduled days done")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "All habits in November 2026" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open history of Morning walk" })).toHaveAttribute(
      "href",
      expect.stringContaining(HABIT),
    );
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByTestId("habits-view-trends"));
    expect(screen.queryByTestId("habit-trends")).not.toBeInTheDocument();
  });
});

describe("the progressive editor", () => {
  it("opens on the name, keeps the other fields behind More options and creates with defaults", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((_, init) =>
      init?.method === "POST" ? reply({ habit: habitSummary() }) : reply({ list: list() }),
    );
    renderList(list());
    await user.click(screen.getByTestId("habit-new"));
    const form = await screen.findByTestId("habit-form");
    expect(within(form).getByTestId("habit-name")).toBeVisible();
    expect(within(form).getByTestId("habit-more-fields")).not.toBeVisible();
    await user.type(within(form).getByTestId("habit-name"), "Stretch");
    await user.click(within(form).getByTestId("habit-save"));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
    });
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "POST") ?? [];
    expect(JSON.parse(typeof init?.body === "string" ? init.body : "{}")).toMatchObject({
      name: "Stretch",
      schedule: { kind: "daily" },
      startsOn: "2026-11-10",
    });
  });

  it("opens More options on demand and with it a field that is wrong", async () => {
    const user = userEvent.setup();
    renderList(list());
    await user.click(screen.getByTestId("habit-new"));
    const form = await screen.findByTestId("habit-form");
    await user.click(within(form).getByTestId("habit-more-options"));
    expect(within(form).getByTestId("habit-more-fields")).toBeVisible();
    await user.type(within(form).getByTestId("habit-name"), "Stretch");
    await user.clear(within(form).getByTestId("habit-starts-on"));
    await user.click(within(form).getByTestId("habit-more-options"));
    expect(within(form).getByTestId("habit-more-fields")).not.toBeVisible();
    await user.click(within(form).getByTestId("habit-save"));
    expect(within(form).getByTestId("habit-more-fields")).toBeVisible();
  });

  it("asks before dropping unsaved changes and keeps them when asked to", async () => {
    const user = userEvent.setup();
    renderList(list());
    await user.click(screen.getByTestId("habit-new"));
    await user.type(await screen.findByTestId("habit-name"), "Stretch");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Discard this habit?");
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByTestId("habit-name")).toHaveValue("Stretch");
  });
});
