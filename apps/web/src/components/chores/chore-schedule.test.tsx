// S21: the personal chore reminder, moving an occurrence, the Chores calendar board, the Chore
// schedule widget and the daily summary setting. The database decides every right, the moment a
// reminder fires and what moving does (tests/db/rls/chore-overview-reminders.test.sql); these tests
// check what the interface sends, shows in words and remembers.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";

import { ToastProvider } from "@/components/ui/toast";
import type {
  ChoreAgenda,
  ChoreAgendaItem,
  ChorePool,
  ChoreReminderView,
  ManagerSummarySetting,
} from "@/chores/api";
import { parseChoreCalendarQuery } from "@/chores/calendar";
import type { DateTimeFormats } from "@/invitations/format";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { ChoreCalendarBoard } from "./chore-calendar-board";
import { ChoreMove } from "./chore-move";
import { ChoreReminder } from "./chore-reminder";
import { ChoreScheduleWidget, layoutStorageKey } from "./chore-schedule-widget";
import { ChoreSummarySetting } from "./chore-summary-setting";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const HOME = "0b6f6c55-3a4e-4f7a-9f15-9a8a1d0c0001";
const OCCURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const OTHER_OCCURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0022";
const CHORE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021";
const ME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0041";
const BEA = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0042";
const WIDGET = "w-schedule";

const formats: DateTimeFormats = {
  timeZone: "Europe/Brussels",
  dateFormat: "ymd-dash",
  timeFormat: "24h",
  locale: "en",
};
const members = [
  { id: ME, name: "Ann", isSelf: true },
  { id: BEA, name: "Bea", isSelf: false },
];
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const weekdaysLong = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
});

function withToasts(ui: ReactElement) {
  return renderWithQuery(
    <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss">
      {ui}
    </ToastProvider>,
  );
}

function item(extra: Partial<ChoreAgendaItem> = {}): ChoreAgendaItem {
  return {
    id: OCCURRENCE,
    choreId: CHORE,
    title: "Dishes",
    date: "2026-10-21",
    category: null,
    status: "open",
    overdue: false,
    inRework: false,
    needsReassignment: false,
    awaitingVolunteer: false,
    assigneeIds: [ME],
    minutes: null,
    revision: 3,
    recurring: false,
    projected: false,
    ...extra,
  };
}

describe("a personal chore reminder", () => {
  const view: ChoreReminderView = {
    occurrenceId: OCCURRENCE,
    dueDate: "2026-10-25",
    timeZone: "Europe/Brussels",
    canSet: true,
    reminder: null,
    revision: 0,
    channels: { inApp: true, email: true },
  };

  it("previews the moment before saving it", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          outcome: "preview",
          fireAt: "2026-10-24T16:00:00Z",
          dst: null,
          revision: 0,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ outcome: "saved", fireAt: "2026-10-24T16:00:00Z", dst: null, revision: 1 }),
      );
    const { container } = renderWithQuery(
      <ChoreReminder occurrenceId={OCCURRENCE} view={view} formats={formats} />,
    );
    expect(screen.getByText(/No reminder/)).toBeInTheDocument();
    await user.click(screen.getByTestId("chore-reminder-edit"));
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByTestId("chore-reminder-preview-button"));
    expect(await screen.findByTestId("chore-reminder-preview")).toHaveTextContent(
      "Reminds you 2026-10-24 18:00.",
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/chore-occurrences/${OCCURRENCE}/reminder`);
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      mode: "relative",
      daysBefore: 1,
      time: "18:00",
      expectedRevision: 0,
      dryRun: true,
    });
    await user.click(screen.getByTestId("chore-reminder-save"));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toMatchObject({ dryRun: false });
  });

  it("refuses a day count out of range without asking the server", async () => {
    const user = userEvent.setup();
    renderWithQuery(<ChoreReminder occurrenceId={OCCURRENCE} view={view} formats={formats} />);
    await user.click(screen.getByTestId("chore-reminder-edit"));
    await user.clear(screen.getByTestId("chore-reminder-days"));
    await user.type(screen.getByTestId("chore-reminder-days"), "31");
    await user.click(screen.getByTestId("chore-reminder-preview-button"));
    expect(screen.getByText("Enter a whole number from 0 to 30.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says a moment in the past cannot be used", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(Response.json({ error: "in-past" }, { status: 409 }));
    renderWithQuery(<ChoreReminder occurrenceId={OCCURRENCE} view={view} formats={formats} />);
    await user.click(screen.getByTestId("chore-reminder-edit"));
    await user.click(screen.getByLabelText("At a date and time"));
    await user.click(screen.getByTestId("chore-reminder-preview-button"));
    expect(
      await screen.findByText("That moment has already passed. Choose a later time."),
    ).toBeInTheDocument();
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      mode: "absolute",
      localAt: "2026-10-25T09:00",
    });
  });

  it("shows a saved reminder with daylight saving and channels off, and removes it", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(Response.json({ outcome: "removed", revision: 2 }));
    renderWithQuery(
      <ChoreReminder
        occurrenceId={OCCURRENCE}
        view={{
          ...view,
          revision: 1,
          channels: { inApp: false, email: false },
          reminder: {
            mode: "absolute",
            localAt: "2026-03-29T02:30:00",
            daysBefore: null,
            time: null,
            fireAt: "2026-03-29T01:30:00Z",
            dst: "gap",
            status: "scheduled",
          },
        }}
        formats={formats}
      />,
    );
    expect(screen.getByTestId("chore-reminder-current")).toHaveTextContent(/clock change/);
    expect(screen.getByRole("link", { name: "Notification settings" })).toHaveAttribute(
      "href",
      "/settings/notifications",
    );
    await user.click(screen.getByTestId("chore-reminder-remove"));
    await waitFor(() => {
      expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ expectedRevision: 1 });
    });
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("is hidden from someone who is not assigned and has none", () => {
    const { container } = renderWithQuery(
      <ChoreReminder
        occurrenceId={OCCURRENCE}
        view={{ ...view, canSet: false }}
        formats={formats}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("moving an occurrence", () => {
  it("previews the new date, member and effects, then confirms at the revision seen", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          outcome: "preview",
          revision: 3,
          impact: {
            overdue: true,
            remindersMoved: 1,
            remindersEnded: 0,
            handoverEnded: true,
            volunteerEnded: false,
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ outcome: "saved", revision: 4, impact: null }));
    renderWithQuery(
      <ChoreMove
        item={item()}
        targetDate="2026-10-20"
        members={members}
        formats={formats}
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId("chore-move-date")).toHaveValue("2026-10-20");
    await user.selectOptions(screen.getByTestId("chore-move-assignee"), BEA);
    await user.click(screen.getByTestId("chore-move-preview"));
    const summary = await screen.findByTestId("chore-move-summary");
    expect(summary).toHaveTextContent("Date: 2026-10-21 → 2026-10-20");
    expect(summary).toHaveTextContent("Who: you → Bea");
    expect(summary).toHaveTextContent("It will be overdue on the new date.");
    expect(summary).toHaveTextContent("1 personal reminder moves with it.");
    expect(summary).toHaveTextContent("The open handover request ends.");
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      expectedRevision: 3,
      dryRun: true,
      dueDate: "2026-10-20",
      assigneeIds: [BEA],
    });
    await user.click(screen.getByTestId("chore-move-confirm"));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toMatchObject({ dryRun: false });
    expect(router.refresh).toHaveBeenCalled();
  });

  it("names an immediate release and confirms it with the move", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          outcome: "preview",
          revision: 3,
          impact: {
            overdue: true,
            remindersMoved: 0,
            remindersEnded: 0,
            handoverEnded: false,
            volunteerEnded: false,
            releaseNow: true,
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ outcome: "saved", revision: 4, impact: null }));
    renderWithQuery(
      <ChoreMove
        item={item()}
        targetDate="2026-10-10"
        members={members}
        formats={formats}
        onClose={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("chore-move-preview"));
    expect(await screen.findByTestId("chore-move-summary")).toHaveTextContent(
      "The claim goes back to the pool now",
    );
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).not.toHaveProperty("confirmRelease");
    await user.click(screen.getByTestId("chore-move-confirm"));
    await waitFor(() => {
      expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toMatchObject({
        dryRun: false,
        confirmRelease: true,
      });
    });
  });

  it("asks for a change before previewing nothing", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <ChoreMove
        item={item()}
        targetDate={null}
        members={members}
        formats={formats}
        onClose={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("chore-move-preview"));
    expect(screen.getByText("Choose another date or member first.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens for nothing that cannot be moved", () => {
    renderWithQuery(
      <ChoreMove
        item={item({ id: null, revision: null, projected: true })}
        targetDate={null}
        members={members}
        formats={formats}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("chore-move")).toBeNull();
  });
});

describe("the Chores calendar board", () => {
  const week = [
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
    "2026-10-23",
    "2026-10-24",
    "2026-10-25",
  ];
  const board = (canManage: boolean, items: readonly ChoreAgendaItem[]) =>
    renderWithQuery(
      <ChoreCalendarBoard
        homeId={HOME}
        query={parseChoreCalendarQuery({})}
        anchor="2026-10-19"
        weeks={[week]}
        today="2026-10-21"
        selected="2026-10-21"
        items={items}
        members={members}
        canManage={canManage}
        formats={formats}
        weekdays={weekdays}
        weekdaysLong={weekdaysLong}
        title="2026-10-19 – 2026-10-25"
      />,
    );

  it("names states in words and offers Move only to managers, never on a planned date", async () => {
    const items = [
      item({ overdue: true }),
      item({ id: null, revision: null, projected: true, title: "Laundry", recurring: true }),
    ];
    const { container, unmount } = board(true, items);
    const panel = screen.getByTestId("chore-calendar-panel");
    expect(within(panel).getByText("Overdue")).toBeInTheDocument();
    expect(within(panel).getByText("Planned")).toBeInTheDocument();
    expect(within(panel).getAllByTestId("chore-calendar-move")).toHaveLength(1);
    expect(await axeViolations(container)).toEqual([]);
    unmount();
    board(false, items);
    expect(screen.queryByTestId("chore-calendar-move")).toBeNull();
  });

  it("opens the Move dialog with the day a chore is dropped on", async () => {
    board(true, [item()]);
    const chip = screen
      .getAllByTestId("chore-calendar-item")
      .map((entry) => entry.querySelector("a"))
      .find((link) => link?.getAttribute("draggable") === "true");
    if (!chip) throw new Error("no draggable chip");
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.dragStart(chip, { dataTransfer });
    const target = screen
      .getAllByTestId("chore-calendar-day")
      .find((cell) => cell.dataset.date === "2026-10-23");
    if (!target) throw new Error("no target day");
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
    expect(await screen.findByTestId("chore-move-date")).toHaveValue("2026-10-23");
  });

  it("moves with the keyboard from the day panel", async () => {
    const user = userEvent.setup();
    board(true, [item()]);
    screen.getByTestId("chore-calendar-move").focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByTestId("chore-move-date")).toHaveValue("2026-10-21");
  });
});

describe("the Chore schedule widget", () => {
  const agenda: ChoreAgenda = {
    today: "2026-10-21",
    canManage: false,
    truncated: false,
    items: [
      item({ title: "Dishes" }),
      item({ id: OTHER_OCCURRENCE, title: "Bins", status: "pending_approval" }),
      item({ id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0023", title: "Plants", inRework: true }),
      item({ id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0024", title: "Mop", assigneeIds: [BEA] }),
    ],
  };
  const pool: ChorePool = {
    weekStart: "2026-10-19",
    today: "2026-10-21",
    truncated: false,
    rows: [
      {
        id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0030",
        choreId: CHORE,
        title: "Windows",
        kind: "one_off",
        category: null,
        scheduledDate: "2026-10-23",
        dueDate: "2026-10-23",
        section: "week",
        overdue: false,
        minutes: null,
        stepsTotal: 0,
        requiresApproval: false,
        restricted: false,
        eligible: true,
        closesOn: null,
        revision: 1,
      },
    ],
  };
  const widget = (layout: "matrix" | "cards" = "matrix") =>
    withToasts(
      <ChoreScheduleWidget
        homeId={HOME}
        widgetId={WIDGET}
        userId={ME}
        config={{ layout, limit: 2 }}
        today="2026-10-21"
        weekStart="2026-10-19"
        weekdays={weekdays}
        weekdaysLong={weekdaysLong}
        members={members}
        formats={formats}
        agenda={agenda}
        pool={pool}
        loadedAt="2026-10-21T08:00:00Z"
      />,
    );

  it("shows the week by member and day with states in words and +N more in place", async () => {
    const user = userEvent.setup();
    const { container } = widget();
    const table = screen.getByTestId("chore-schedule-matrix-table");
    expect(within(table).getByRole("rowheader", { name: "You" })).toBeInTheDocument();
    expect(within(table).getByText(/today/, { selector: "span" })).toBeInTheDocument();
    expect(within(table).getByText(/Pending approval/)).toBeInTheDocument();
    const more = within(table).getByRole("button", { name: /Show 1 more chore for You/ });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await user.click(more);
    expect(within(table).getByText(/Needs rework/)).toBeInTheDocument();
    expect(
      within(table).getByRole("button", { name: /Show fewer chores for You/ }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("lists the week's unassigned chores to claim, filtered in Day view with the whole week a step away", async () => {
    const user = userEvent.setup();
    widget();
    const unassigned = screen.getByTestId("chore-schedule-unassigned");
    expect(within(unassigned).getByText("Windows")).toBeInTheDocument();
    expect(within(unassigned).getByTestId("chore-claim")).toBeInTheDocument();
    await user.click(screen.getByTestId("chore-schedule-day"));
    expect(screen.getByTestId("chore-schedule-title")).toHaveTextContent("Wednesday");
    expect(within(unassigned).queryByText("Windows")).toBeNull();
    expect(within(unassigned).getByText("Filtered to 2026-10-21.")).toBeInTheDocument();
    await user.click(screen.getByTestId("chore-schedule-whole-week"));
    expect(within(unassigned).getByText("Windows")).toBeInTheDocument();
  });

  it("remembers the viewer's layout per widget and reads other weeks on demand", async () => {
    const user = userEvent.setup();
    const { unmount } = widget();
    await user.click(screen.getByTestId("chore-schedule-cards"));
    expect(screen.getAllByTestId("chore-schedule-card")).toHaveLength(7);
    expect(window.localStorage.getItem(layoutStorageKey(WIDGET))).toBe("cards");
    unmount();
    widget("matrix");
    expect(await screen.findAllByTestId("chore-schedule-card")).toHaveLength(7);

    fetchMock.mockImplementation((url) =>
      Promise.resolve(
        (typeof url === "string" ? url : "").startsWith("/api/v1/chore-schedule")
          ? Response.json({ ...agenda, items: [item({ title: "Gutters", date: "2026-10-28" })] })
          : Response.json({ pool: { ...pool, rows: [] } }),
      ),
    );
    await user.click(screen.getByTestId("chore-schedule-next"));
    expect((await screen.findAllByText("Gutters")).length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/chore-schedule?homeId=${HOME}&from=2026-10-26&to=2026-11-01`,
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/chore-pool?homeId=${HOME}&date=2026-10-26`);
  });
});

describe("the daily summary setting", () => {
  const setting: ManagerSummarySetting = {
    canManage: true,
    enabled: false,
    hour: 8,
    timeZone: null,
    revision: 0,
  };

  it("turns the summary on at an hour in the person's timezone", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(Response.json({ outcome: "saved", revision: 1 }));
    const { container } = renderWithQuery(
      <ChoreSummarySetting homeId={HOME} setting={setting} timeZone="Europe/Brussels" />,
    );
    expect(screen.getByTestId("chore-summary-hour")).toBeDisabled();
    expect(screen.getByTestId("chore-summary-save")).toBeDisabled();
    await user.click(screen.getByLabelText("Send me this summary once a day"));
    await user.selectOptions(screen.getByTestId("chore-summary-hour"), "7");
    expect(screen.getByText("In your timezone (Europe/Brussels).")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByTestId("chore-summary-save"));
    await waitFor(() => {
      expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
        homeId: HOME,
        enabled: true,
        hour: 7,
        expectedRevision: 0,
      });
    });
  });
});
