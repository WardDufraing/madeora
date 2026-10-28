// S28: the habit list, today's Complete and Undo, and the reminder actions in the notification
// centre. The database decides every right, day and streak (tests/db/rls/habits.test.sql); these
// tests check what the interface shows, sends and confirms.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ToastProvider } from "@/components/ui/toast";
import type { HabitList } from "@/habits/api";
import { CHECKIN, HABIT, MEMBER, habitCheckin, habitSummary } from "@/habits/testing";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { HabitReminderActions } from "./habit-reminder-actions";
import { HabitsView } from "./habits-view";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/habits" }));

const NOTICE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0090";

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;
/** The address a fetch call went to. */
const urlOf = (input: RequestInfo | URL | undefined): string =>
  input === undefined
    ? ""
    : typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
const reply = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
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

function renderList(initial: HabitList = list()) {
  return renderWithQuery(
    <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss">
      <HabitsView
        homeId={null}
        view="active"
        query=""
        initialList={initial}
        members={[{ id: MEMBER, name: "Ann", isSelf: true }]}
        today="2026-11-10"
        weekStart="monday"
        timeZone="Europe/Brussels"
        timeZones={["Europe/Brussels"]}
      />
    </ToastProvider>,
  );
}

/** Answers check-ins and undos as the database would, and the list read afterwards. */
function database(complete: { status: number; body: unknown }) {
  fetchMock.mockImplementation((input, init) => {
    const url = urlOf(input);
    if (url.endsWith(`/habits/${HABIT}/checkins`)) return reply(complete.status, complete.body);
    if (url.endsWith(`/habit-checkins/${CHECKIN}/undo`)) {
      return reply(200, { outcome: "undone", checkin: habitCheckin({ status: "undone" }) });
    }
    if (init?.method === undefined || init.method === "GET") return reply(200, { list: list() });
    return reply(500, { error: "failed" });
  });
}

describe("the habit list", () => {
  it("shows each habit's schedule, streak and today, without accessibility violations", async () => {
    const { container } = renderList();
    const card = screen.getByRole("article", { name: "Morning walk" });
    expect(within(card).getByTestId("habit-streak")).toHaveTextContent("3 times in a row");
    expect(
      within(card).getByRole("button", { name: "Complete Morning walk for today" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "New habit" })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("completes today, confirms it and offers Undo, which undoes it", async () => {
    const user = userEvent.setup();
    database({
      status: 200,
      body: { outcome: "completed", checkin: habitCheckin(), milestone: null },
    });
    renderList();
    await user.click(screen.getByRole("button", { name: "Complete Morning walk for today" }));
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(urlOf(url)).toContain(`/habits/${HABIT}/checkins`);
    expect(bodyOf(init)).toMatchObject({ onDate: "2026-11-10", note: null, source: "app" });
    expect(await screen.findAllByText("Morning walk completed")).not.toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([u]) => urlOf(u).endsWith(`${CHECKIN}/undo`))).toBe(true);
    });
    expect(await screen.findAllByText("Completion of Morning walk undone")).not.toHaveLength(0);
    expect(router.refresh).toHaveBeenCalled();
  });

  it("celebrates a newly reached milestone in text only", async () => {
    const user = userEvent.setup();
    database({
      status: 200,
      body: {
        outcome: "completed",
        checkin: habitCheckin(),
        milestone: { threshold: 7, unit: "occurrences", reachedOn: "2026-11-10", celebrate: true },
      },
    });
    renderList();
    await user.click(screen.getByRole("button", { name: "Complete Morning walk for today" }));
    expect(await screen.findAllByText(/Morning walk: 7 times/)).not.toHaveLength(0);
  });

  it("explains a refused check-in", async () => {
    const user = userEvent.setup();
    database({ status: 409, body: { error: "paused", habit: habitSummary() } });
    renderList();
    await user.click(screen.getByRole("button", { name: "Complete Morning walk for today" }));
    expect(await screen.findByText("This habit is paused on this day.")).toBeInTheDocument();
  });

  it("shows who completed today, with Undo only for one's own completion", () => {
    renderList(
      list({
        habits: [
          habitSummary({
            todayState: "completed",
            todayBlock: "already_completed",
            todayCheckin: habitCheckin({ mine: false, action: null }),
          }),
        ],
      }),
    );
    expect(screen.getByTestId("habit-today-done")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Undo/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Complete/ })).not.toBeInTheDocument();
  });

  it("gives read-only viewers the state but no Complete, and no New habit", () => {
    renderList(
      list({
        access: "view",
        habits: [habitSummary({ access: "view", todayState: "pending" })],
      }),
    );
    expect(screen.getByTestId("habit-today-state")).toHaveTextContent("Not done yet");
    expect(screen.queryByRole("button", { name: /Complete/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New habit" })).not.toBeInTheDocument();
  });

  it("shows a weekly habit's progress, adjusted for paused days", () => {
    renderList(
      list({
        habits: [
          habitSummary({
            schedule: { effectiveOn: "2026-11-01", kind: "weekly", weekdays: [], target: 3 },
            week: {
              weekOn: "2026-11-09",
              firstOn: "2026-11-09",
              lastOn: "2026-11-15",
              completions: 1,
              target: 3,
              adjusted: 2,
              outcome: "pending",
            },
            streak: { current: 2, unit: "weeks", longestOccurrences: 0, longestWeeks: 4 },
          }),
        ],
      }),
    );
    expect(screen.getByTestId("habit-week-progress")).toHaveTextContent(
      "1 of 2 this week (target 3, fewer days this week)",
    );
  });

  it("shows nothing to complete on a day that is not scheduled", () => {
    renderList(
      list({
        habits: [habitSummary({ todayState: "not_scheduled", todayBlock: "not_scheduled" })],
      }),
    );
    expect(screen.queryByRole("button", { name: /Complete/ })).not.toBeInTheDocument();
  });
});

describe("habit reminder actions", () => {
  function renderActions(onDate: string | null = "2026-11-10") {
    return renderWithQuery(
      <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss">
        <HabitReminderActions
          notificationId={NOTICE}
          habitId={HABIT}
          habitName="Morning walk"
          onDate={onDate}
        />
      </ToastProvider>,
    );
  }

  it("completes a weekly habit's today from the reminder", async () => {
    const user = userEvent.setup();
    database({ status: 200, body: { outcome: "completed", checkin: habitCheckin() } });
    const { container } = renderActions(null);
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Complete Morning walk" }));
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      onDate: null,
      source: "notification",
    });
    expect(await screen.findAllByText("Morning walk completed")).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: "Complete Morning walk" })).toBeDisabled();
  });

  it("snoozes once, and explains a snooze into quiet hours", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((_input, init) => {
      const minutes = (bodyOf(init) as { minutes: number }).minutes;
      return minutes === 60
        ? reply(409, { error: "quiet-hours" })
        : reply(200, { dueAt: "2026-11-10T08:30:00Z" });
    });
    renderActions();
    await user.click(
      screen.getByRole("button", { name: "Snooze the reminder for Morning walk by 60 minutes" }),
    );
    expect(
      await screen.findByText("That would fall in your quiet hours. Choose a shorter snooze."),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Snooze the reminder for Morning walk by 15 minutes" }),
    );
    expect(
      await screen.findByText("Snoozed: you will be reminded again in 15 minutes."),
    ).toBeInTheDocument();
    expect(urlOf(fetchMock.mock.calls[1]?.[0])).toContain(`/habit-reminders/${NOTICE}/snooze`);
    expect(
      screen.getByRole("button", { name: "Snooze the reminder for Morning walk by 30 minutes" }),
    ).toBeDisabled();
  });
});
