import { notificationKinds } from "@madeora/domain/notifications";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ToastProvider } from "@/components/ui/toast";
import type { NotificationView } from "@/notifications/types";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { messageKeyFor, NotificationList } from "./notification-list";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const { default: en } = await import("@/i18n/messages/en.json");
  return {
    getLocale: () => Promise.resolve("en"),
    getTranslations: (namespace: string) =>
      Promise.resolve(
        createTranslator({ locale: "en", messages: en, namespace: namespace as "Notifications" }),
      ),
  };
});

const fetchMock = vi.fn<typeof fetch>();
const bodyText = (body: BodyInit | null | undefined): string =>
  typeof body === "string" ? body : "null";
const formats = {
  timeZone: "UTC",
  dateFormat: "dmy-slash",
  timeFormat: "24h",
  locale: "en",
} as const;
const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";

function item(overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a1",
    kind: "recovery.claimant_paused",
    homeId: HOME_ID,
    homeName: "Thuis",
    objectionEndsAt: null,
    decision: null,
    reason: null,
    occurrenceId: null,
    taskId: null,
    dueDate: null,
    taskTitle: null,
    habitId: null,
    habitName: null,
    goalId: null,
    goalName: null,
    goalReminder: null,
    deadline: null,
    onDate: null,
    weekly: false,
    progress: null,
    resumesOn: null,
    automatic: false,
    duringQuietHours: false,
    createdAt: "2026-10-15T10:00:00Z",
    readAt: null,
    ...overrides,
  };
}

async function show(items: readonly NotificationView[]) {
  const element = await NotificationList({ items, formats });
  return renderWithQuery(<>{element}</>);
}

/** Inside the app shell's toast region (S28: a habit reminder's Complete confirms with a toast). */
async function showWithToasts(items: readonly NotificationView[]) {
  const element = await NotificationList({ items, formats });
  return renderWithQuery(
    <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss">
      {element}
    </ToastProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  router.refresh.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("messageKeyFor", () => {
  it("has a message for every kind the database writes", () => {
    for (const kind of notificationKinds) {
      expect(messageKeyFor({ kind, decision: null }), kind).not.toBe("kindUnknown");
    }
  });

  it("picks the join request message by its decision, and falls back for unknown kinds", () => {
    expect(messageKeyFor({ kind: "join_request.decided", decision: "declined" })).toBe(
      "kindJoinRequestDeclined",
    );
    expect(messageKeyFor({ kind: "join_request.decided", decision: "approved" })).toBe(
      "kindJoinRequestApproved",
    );
    expect(messageKeyFor({ kind: "chores.assigned", decision: null })).toBe("kindUnknown");
  });

  it("picks a chore notice's words by its outcome, with a neutral fallback", () => {
    expect(messageKeyFor({ kind: "chore.claim_released", decision: null, reason: "auto" })).toBe(
      "kindChoreClaimReleasedAuto",
    );
    expect(messageKeyFor({ kind: "chore.claim_released", decision: null, reason: "manager" })).toBe(
      "kindChoreClaimReleasedManager",
    );
    expect(messageKeyFor({ kind: "chore.claim_released", decision: null })).toBe(
      "kindChoreClaimReleased",
    );
    expect(
      messageKeyFor({ kind: "chore.reassignment_answered", decision: "awaiting_manager" }),
    ).toBe("kindChoreReassignmentAwaitingManager");
    expect(messageKeyFor({ kind: "chore.reassignment_decided", decision: "refused" })).toBe(
      "kindChoreReassignmentRefused",
    );
    // A decision that belongs to another kind does not change the words.
    expect(messageKeyFor({ kind: "chore.reassignment_decided", decision: "approved" })).toBe(
      "kindChoreReassignmentDecided",
    );
  });
});

describe("NotificationList", () => {
  it("says there is nothing yet", async () => {
    const { container } = await show([]);
    expect(screen.getByTestId("notifications-empty")).toHaveTextContent("no notifications yet");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows the sentence, its source Home, the time and unread state", async () => {
    const { container } = await show([
      item(),
      item({ id: "b", readAt: "2026-10-15T11:00:00Z", kind: "recovery.claimant_rejected" }),
    ]);
    const [unread, read] = screen.getAllByTestId("notification");
    expect(unread).toHaveAttribute("data-unread", "true");
    expect(unread).toHaveTextContent("Unread.");
    expect(unread).toHaveTextContent("Your ownership request for ⁨Thuis⁩ is paused.");
    expect(unread).toHaveTextContent("From ⁨Thuis⁩");
    expect(unread).toHaveTextContent("15/10/2026 10:00");
    expect(read).toHaveAttribute("data-unread", "false");
    expect(within(read as HTMLElement).queryByRole("button")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("formats the objection end in the viewer's timezone and marks quiet-hours arrivals", async () => {
    await show([
      item({
        kind: "recovery.member_objection_open",
        objectionEndsAt: "2026-10-29T16:00:00Z",
        duringQuietHours: true,
      }),
    ]);
    const row = screen.getByTestId("notification");
    expect(row).toHaveTextContent("You can object until 29/10/2026 16:00.");
    expect(row).toHaveTextContent("Arrived during your quiet hours");
  });

  it("links to the page the notification is about", async () => {
    await show([item({ kind: "recovery.claimant_ready" })]);
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      `/homes/${HOME_ID}/recovery`,
    );
  });

  it("names a reminder's task and due day, and links to the task", async () => {
    const taskId = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00b1";
    await show([
      item({ kind: "task.reminder", taskId, dueDate: "2027-03-28", taskTitle: "Bins out" }),
      item({ id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a2", kind: "task.reminder", taskId }),
    ]);
    const [named, hidden] = screen.getAllByTestId("notification");
    expect(named).toHaveTextContent("Reminder: \u2068Bins out\u2069, due 28/03/2027.");
    expect(hidden).toHaveTextContent("Reminder: a task.");
    expect(within(named as HTMLElement).getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      `/homes/${HOME_ID}/tasks/${taskId}`,
    );
  });

  it("names a habit reminder's day, offers Complete and Snooze, and links to the habit", async () => {
    const habitId = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00d1";
    const { container } = await showWithToasts([
      item({ kind: "habit.reminder", habitId, habitName: "Walk", onDate: "2026-11-10" }),
      item({
        id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a3",
        kind: "habit.paused",
        habitId,
        habitName: "Walk",
        resumesOn: "2026-11-20",
      }),
      item({
        id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a4",
        kind: "habit.resumed",
        habitId,
        automatic: true,
      }),
    ]);
    const [reminder, paused, resumed] = screen.getAllByTestId("notification");
    expect(reminder).toHaveTextContent("Reminder: \u2068Walk\u2069 for 10/11/2026.");
    expect(
      within(reminder as HTMLElement).getByRole("button", { name: "Complete Walk" }),
    ).toBeInTheDocument();
    expect(within(reminder as HTMLElement).getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      `/homes/${HOME_ID}/habits/${habitId}`,
    );
    expect(paused).toHaveTextContent("is paused and resumes on 20/11/2026.");
    expect(resumed).toHaveTextContent("The pause of a habit in \u2068Thuis\u2069 has ended.");
    expect(within(resumed as HTMLElement).queryByRole("button", { name: /Complete/ })).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows a numeric habit's progress when the reminder was sent and opens the habit instead of Complete", async () => {
    const habitId = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00d1";
    const { container } = await showWithToasts([
      item({
        kind: "habit.reminder",
        habitId,
        habitName: "Water",
        onDate: "2026-11-10",
        progress: { total: 500, target: 2000, unit: "ml", unitKind: "preset" },
      }),
      item({
        id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a5",
        kind: "habit.reminder",
        habitId,
        habitName: "Tea",
        onDate: "2026-11-10",
        progress: { total: 1, target: 3, unit: "cups", unitKind: "custom" },
      }),
      item({
        id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a6",
        kind: "habit.reminder",
        habitId,
        habitName: "Sleep",
        onDate: "2026-11-10",
        progress: { total: 0, target: 8, unit: "glasses", unitKind: "preset" },
      }),
    ]);
    const [water, tea, glasses] = screen.getAllByTestId("notification");
    expect(water).toHaveTextContent(
      "Reminder: \u2068Water\u2069 for 10/11/2026. So far: 500 / 2,000 mL.",
    );
    expect(tea).toHaveTextContent("So far: 1 / 3 \u2068cups\u2069.");
    expect(glasses).toHaveTextContent("So far: 0 / 8 glasses.");
    for (const row of [water, tea, glasses]) {
      expect(within(row as HTMLElement).queryByRole("button", { name: /Complete/ })).toBeNull();
      expect(within(row as HTMLElement).getByTestId("habit-reminder-add-progress")).toHaveAttribute(
        "href",
        `/homes/${HOME_ID}/habits/${habitId}`,
      );
      // Snoozing still works: the reminder, not the quantity, is what is postponed.
      expect(
        within(row as HTMLElement).getAllByRole("button", { name: /Snooze the reminder/ }),
      ).not.toHaveLength(0);
    }
    expect(await axeViolations(container)).toEqual([]);
  });

  it("words a chore handover notice by its answer and links to the occurrence", async () => {
    const occurrenceId = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00c1";
    await show([item({ kind: "chore.reassignment_answered", decision: "declined", occurrenceId })]);
    const row = screen.getByTestId("notification");
    expect(row).toHaveTextContent(
      "Your request to hand over a chore in \u2068Thuis\u2069 was declined.",
    );
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      `/homes/${HOME_ID}/chores/${occurrenceId}`,
    );
  });

  it("copes with a Home that is gone and a kind it does not know", async () => {
    await show([item({ kind: "chores.assigned", homeId: null, homeName: null })]);
    const row = screen.getByTestId("notification");
    expect(row).toHaveTextContent("Something happened in a Home.");
    expect(within(row).queryByText(/^From/)).toBeNull();
  });

  it("marks one notification read through the API and refreshes", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(
      Promise.resolve(new Response(JSON.stringify({ updated: 1 }), { status: 200 })),
    );
    await show([item()]);
    await user.click(screen.getByRole("button", { name: /Mark as read: / }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    // The button goes away with the refresh, so focus moves to the row first.
    expect(screen.getByTestId("notification")).toHaveFocus();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/me/notifications/read");
    expect(JSON.parse(bodyText(init?.body))).toEqual({ ids: [item().id] });
  });

  it("marks everything read, announcing it", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(
      Promise.resolve(new Response(JSON.stringify({ updated: 2 }), { status: 200 })),
    );
    await show([item(), item({ id: "b" })]);
    await user.click(screen.getByRole("button", { name: "Mark all as read" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "All notifications are marked as read.",
    );
    expect(JSON.parse(bodyText(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ all: true });
  });

  it("says when marking failed", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(Promise.resolve(new Response("{}", { status: 500 })));
    await show([item()]);
    await user.click(screen.getByRole("button", { name: /Mark as read: / }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not mark as read");
  });

  it("offers no mark-all button when everything is read", async () => {
    await show([item({ readAt: "2026-10-15T11:00:00Z" })]);
    expect(screen.queryByRole("button", { name: "Mark all as read" })).toBeNull();
  });
});
