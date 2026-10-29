// S30: goals in the interface. The database decides every right, total and state
// (tests/db/rls/goals.test.sql); these tests check what people read and type in en and nl, what is
// sent, how refusals read, and that the views pass automated accessibility checks.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ToastProvider } from "@/components/ui/toast";
import {
  ENTRY,
  GOAL,
  HOME,
  MEMBER,
  goalDetail,
  goalEntry,
  goalList,
  goalSummary,
} from "@/goals/testing";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { ReopenDialog, RemindersDialog, TargetDialog } from "./goal-dialogs";
import { GoalDetailView } from "./goal-detail";
import { GoalFormDialog } from "./goal-form-dialog";
import { GoalProgressMeter, ProgressForm } from "./goal-progress";
import { GoalsWidgetBody } from "./goal-widget-body";
import { GoalsView } from "./goals-view";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/goals" }));

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): Record<string, unknown> =>
  typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
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
  router.push.mockClear();
});

/** Answers by address: the first handler whose test matches; anything else is an empty answer. */
function routeFetch(
  handlers: readonly {
    readonly when: (url: string, method: string) => boolean;
    readonly answer: () => Promise<Response>;
  }[],
) {
  fetchMock.mockImplementation((input, init) => {
    const url = urlOf(input);
    const method = init?.method ?? "GET";
    const found = handlers.find((handler) => handler.when(url, method));
    return found ? found.answer() : reply(200, {});
  });
}
/** The requests sent to an address that includes `part` with `method`. */
function sent(part: string, method: string): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => urlOf(input).includes(part) && (init?.method ?? "GET") === method)
    .map(([, init]) => bodyOf(init));
}

function withToasts(ui: React.ReactElement, locale: "en" | "nl" = "en") {
  return renderWithQuery(
    <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss">
      {ui}
    </ToastProvider>,
    locale,
  );
}

describe("the goals list", () => {
  it("shows progress, status and New goal for managers, and passes axe", async () => {
    const { container } = withToasts(
      <GoalsView
        homeId={HOME}
        view="active"
        query=""
        initialList={goalList({
          goals: [goalSummary(), goalSummary({ id: ENTRY, title: "Old one", status: "overdue" })],
        })}
        today="2026-11-10"
        timeZone="Europe/Brussels"
        timeZones={[]}
        weekStart="monday"
      />,
    );
    expect(screen.getByRole("button", { name: "New goal" })).toBeInTheDocument();
    expect(screen.getAllByTestId("goal-card")).toHaveLength(2);
    expect(screen.getAllByTestId("goal-progress-text")[0]).toHaveTextContent("7.5 / 10 km");
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.getByLabelText("Members")).toHaveValue("contribute");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("hides New goal and the setting from members who only view", () => {
    withToasts(
      <GoalsView
        homeId={HOME}
        view="active"
        query=""
        initialList={goalList({ access: "view", memberAccess: "view", goals: [] })}
        today="2026-11-10"
        timeZone="Europe/Brussels"
        timeZones={[]}
        weekStart="monday"
      />,
    );
    expect(screen.queryByRole("button", { name: "New goal" })).not.toBeInTheDocument();
    expect(screen.getByText("Members only view this Home's goals.")).toBeInTheDocument();
    expect(screen.getByText("There are no goals to show here yet.")).toBeInTheDocument();
  });
});

describe("progress", () => {
  it("keeps the numbers above the target and caps only the bar", () => {
    withToasts(<GoalProgressMeter goal={goalSummary({ total: 12.5, reached: true })} />);
    expect(screen.getByTestId("goal-progress-text")).toHaveTextContent("12.5 / 10 km");
    expect(screen.getByText(/125%/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByTestId("goal-over-target")).toHaveTextContent("2.5 km above the target");
    expect(screen.getByTestId("goal-target-reached")).toBeInTheDocument();
  });

  it("reads a Dutch decimal, previews the total and sends an exact amount with Undo", async () => {
    const user = userEvent.setup();
    routeFetch([
      {
        when: (url, method) => method === "POST" && url.endsWith(`/goals/${GOAL}/entries`),
        answer: () => reply(200, { outcome: "added", entryId: ENTRY, goal: goalSummary() }),
      },
      {
        when: (url, method) => method === "PATCH" && url.includes("/goal-entries/"),
        answer: () => reply(200, { outcome: "reversed", goal: goalSummary() }),
      },
    ]);
    withToasts(<ProgressForm goal={goalSummary()} mode="add" source="app" />, "nl");
    await user.type(screen.getByLabelText(/Hoeveelheid/), "0,1");
    expect(screen.getByTestId("goal-resulting-total")).toHaveTextContent("7,6 / 10 km");
    await user.click(screen.getByRole("button", { name: "Voortgang toevoegen" }));
    await waitFor(() => {
      expect(sent(`/goals/${GOAL}/entries`, "POST")).toHaveLength(1);
    });
    const [body] = sent(`/goals/${GOAL}/entries`, "POST");
    expect(body).toMatchObject({ quantity: "0.1", mode: "add", source: "app", note: null });
    await user.click(await screen.findByRole("button", { name: "Ongedaan maken" }));
    await waitFor(() => {
      expect(sent("/goal-entries/", "PATCH")).toEqual([{ action: "reverse" }]);
    });
  });

  it("refuses the other locale's separator before sending", async () => {
    const user = userEvent.setup();
    withToasts(<ProgressForm goal={goalSummary()} mode="add" source="app" />, "nl");
    await user.type(screen.getByLabelText(/Hoeveelheid/), "0.5");
    await user.click(screen.getByRole("button", { name: "Voortgang toevoegen" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sets a total with the total it showed and explains a stale one", async () => {
    const user = userEvent.setup();
    routeFetch([
      {
        when: (url, method) => method === "POST" && url.endsWith("/entries"),
        answer: () => reply(409, { error: "stale", goal: goalSummary({ total: 8 }) }),
      },
    ]);
    withToasts(<ProgressForm goal={goalSummary()} mode="total" source="app" />);
    await user.type(screen.getByLabelText(/New total/), "0");
    await user.click(screen.getByRole("button", { name: "Set total" }));
    expect(await screen.findByText(/The total changed meanwhile/)).toBeInTheDocument();
    expect(sent("/entries", "POST")[0]).toMatchObject({
      mode: "total",
      quantity: "0",
      expectedTotal: "7.5",
    });
  });
});

describe("the goal page", () => {
  const entries = {
    when: (url: string, method: string) => method === "GET" && url.includes("/entries"),
    answer: () =>
      reply(200, {
        entries: {
          entries: [
            goalEntry(),
            goalEntry({
              id: GOAL,
              kind: "initial",
              quantity: 5,
              unit: "mi",
              unitKind: "custom",
              by: MEMBER,
              mine: false,
              action: null,
              note: "From last year",
            }),
          ],
          hasMore: false,
        },
      }),
  };

  it("shows Target reached with Mark achieved and sends it with the revision", async () => {
    const user = userEvent.setup();
    const goal = goalDetail({
      total: 10,
      reached: true,
      actions: { contribute: true, setTotal: true, achieve: true, reopen: false, manage: true },
    });
    routeFetch([
      entries,
      {
        when: (url, method) => method === "GET" && url.endsWith(`/goals/${GOAL}`),
        answer: () => reply(200, { goal }),
      },
      {
        when: (url) => url.endsWith("/achievement"),
        answer: () => reply(200, { outcome: "achieved", revision: 4 }),
      },
    ]);
    const { container } = withToasts(
      <GoalDetailView
        initialGoal={goal}
        members={[{ id: MEMBER, name: "Sam", isSelf: false }]}
        contexts={[{ homeId: null, name: "Personal space" }]}
        timeZone="Europe/Brussels"
        timeZones={["Europe/Brussels"]}
      />,
    );
    expect(screen.getByTestId("goal-target-reached")).toBeInTheDocument();
    expect(await screen.findAllByTestId("goal-entry")).toHaveLength(2);
    expect(screen.getByText("From last year")).toBeInTheDocument();
    // An entry recorded before a unit change keeps the unit it was recorded in.
    expect(screen.getByText(/Starting value: 5 mi by Sam/)).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Mark achieved" }));
    await waitFor(() => {
      expect(sent("/achievement", "POST")).toEqual([{ revision: 3, achieved: true }]);
    });
  });

  it("shows only what the database allows a member who views", () => {
    routeFetch([entries]);
    withToasts(
      <GoalDetailView
        initialGoal={goalDetail({
          access: "view",
          actions: {
            contribute: false,
            setTotal: false,
            achieve: false,
            reopen: false,
            manage: false,
          },
        })}
        members={[]}
        contexts={[]}
        timeZone="Europe/Brussels"
        timeZones={[]}
      />,
    );
    expect(screen.queryByRole("button", { name: "Add progress" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Remind me about this goal")).toBeChecked();
  });

  it("names the viewer as the one who achieved and reopened a goal", () => {
    routeFetch([entries]);
    withToasts(
      <GoalDetailView
        initialGoal={goalDetail({
          achievements: [
            {
              id: "00000000-0000-4000-8000-0000000000a1",
              achievedAt: "2026-10-20T10:00:00Z",
              by: null,
              mine: true,
              total: 10.3,
              target: 10,
              unit: "km",
              unitKind: "preset",
              reopenedAt: "2026-10-21T10:00:00Z",
              reopenedBy: null,
              reopenedByMe: true,
              reason: null,
            },
          ],
        })}
        members={[]}
        contexts={[]}
        timeZone="Europe/Brussels"
        timeZones={[]}
      />,
    );
    const achievements = screen.getByTestId("goal-achievements");
    expect(achievements).toHaveTextContent("Achieved by you");
    expect(achievements).toHaveTextContent("reopened by you");
    expect(achievements).not.toHaveTextContent("former member");
  });

  it("lets the contributor reverse their own entry from the list", async () => {
    const user = userEvent.setup();
    routeFetch([
      {
        when: (url, method) => method === "GET" && url.includes("/entries"),
        answer: () =>
          reply(200, { entries: { entries: [goalEntry({ action: "reverse" })], hasMore: false } }),
      },
      {
        when: (url, method) => method === "PATCH" && url.includes("/goal-entries/"),
        answer: () => reply(409, { error: "negative-total", goal: goalSummary() }),
      },
      {
        when: (url, method) => method === "GET" && url.endsWith(`/goals/${GOAL}`),
        answer: () => reply(200, { goal: goalDetail({ access: "contribute" }) }),
      },
    ]);
    withToasts(
      <GoalDetailView
        initialGoal={goalDetail({ access: "contribute" })}
        members={[]}
        contexts={[]}
        timeZone="Europe/Brussels"
        timeZones={[]}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Reverse your contribution of 2.5 km" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Reverse your contribution" });
    expect(within(dialog).queryByLabelText("Correction")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Reverse" }));
    expect(await within(dialog).findByText("This would take the total below 0.")).toBeVisible();
    expect(sent("/goal-entries/", "PATCH")).toEqual([{ action: "reverse", reason: null }]);
  });

  it("keeps an achievement in the history when reopening with a reason", async () => {
    const user = userEvent.setup();
    routeFetch([
      {
        when: (url) => url.endsWith("/achievement"),
        answer: () => reply(200, { outcome: "reopened", revision: 5 }),
      },
    ]);
    withToasts(<ReopenDialog goal={goalSummary({ status: "achieved" })} onClose={() => {}} />);
    await user.type(screen.getByLabelText(/Reason/), "Counted twice");
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => {
      expect(sent("/achievement", "POST")).toEqual([
        { revision: 3, achieved: false, reason: "Counted twice" },
      ]);
    });
  });
});

describe("creating a goal", () => {
  function form(locale: "en" | "nl" = "en") {
    return withToasts(
      <GoalFormDialog
        mode={{ kind: "create", homeId: null }}
        contexts={[]}
        today="2026-11-10"
        timeZone="Europe/Brussels"
        timeZones={["Europe/Brussels", "UTC"]}
        onClose={() => {}}
      />,
      locale,
    );
  }

  it("sends a measurable goal with exact numbers and goes to its page", async () => {
    const user = userEvent.setup();
    routeFetch([
      {
        when: (url, method) => method === "POST" && url.endsWith("/goals"),
        answer: () => reply(201, { id: GOAL, revision: 1 }),
      },
    ]);
    const { container } = form();
    expect(await axeViolations(container)).toEqual([]);
    await user.type(screen.getByLabelText(/Title/), "Run a marathon");
    await user.selectOptions(screen.getByLabelText("Unit"), "km");
    await user.type(screen.getByLabelText(/^Target/), "42.195");
    await user.type(screen.getByLabelText(/Progress so far/), "5");
    await user.click(screen.getByRole("button", { name: "Create goal" }));
    await waitFor(() => {
      expect(sent("/goals", "POST")).toHaveLength(1);
    });
    expect(sent("/goals", "POST")[0]).toMatchObject({
      homeId: null,
      kind: "measurable",
      title: "Run a marathon",
      measure: { target: 42.195, unit: "km", unitKind: "preset" },
      initial: 5,
      deadline: null,
      timeZone: "Europe/Brussels",
    });
    expect(router.push).toHaveBeenCalledWith(expect.stringMatching(/^\/goals\//));
  });

  it("refuses a fraction of a whole-number unit and a past deadline before sending", async () => {
    const user = userEvent.setup();
    form();
    await user.type(screen.getByLabelText(/Title/), "Read");
    await user.selectOptions(screen.getByLabelText("Unit"), "pages");
    await user.type(screen.getByLabelText(/^Target/), "7.5");
    await user.type(screen.getByLabelText(/Deadline/), "2026-11-01");
    await user.click(screen.getByRole("button", { name: "Create goal" }));
    expect(await screen.findByText("The deadline cannot be in the past.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a completion goal without a target", async () => {
    const user = userEvent.setup();
    routeFetch([
      {
        when: (url, method) => method === "POST" && url.endsWith("/goals"),
        answer: () => reply(201, { id: GOAL, revision: 1 }),
      },
    ]);
    form();
    await user.type(screen.getByLabelText(/Title/), "Paint the shed");
    await user.selectOptions(screen.getByLabelText(/Type/), "completion");
    expect(screen.queryByLabelText(/^Target/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create goal" }));
    await waitFor(() => {
      expect(sent("/goals", "POST")[0]).toMatchObject({
        kind: "completion",
        measure: null,
        initial: null,
      });
    });
  });
});

describe("changing the target and reminders", () => {
  it("previews a unit change and saves only after confirming it", async () => {
    const user = userEvent.setup();
    const impact = {
      targetBefore: 10,
      targetAfter: 10,
      unitBefore: "km",
      unitKindBefore: "preset",
      unitAfter: "m",
      unitKindAfter: "preset",
      unitChanged: true,
      total: 7.5,
      reachedBefore: false,
      reachedAfter: false,
      achieved: false,
      reopens: false,
    };
    routeFetch([
      {
        when: (url) => url.endsWith("/target"),
        answer: () => reply(200, { outcome: "preview", revision: 3, impact }),
      },
    ]);
    withToasts(<TargetDialog goal={goalSummary()} onClose={() => {}} onFollowUp={() => {}} />);
    await user.selectOptions(screen.getByLabelText("Unit"), "m");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByTestId("goal-target-impact")).toHaveTextContent(
      /are read in the new unit/,
    );
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await user.click(screen.getByLabelText(/not converted/));
    expect(save).toBeEnabled();
  });

  it("previews reminder moments and marks one that already passed", async () => {
    const user = userEvent.setup();
    routeFetch([
      {
        when: (url) => url.endsWith("/reminders"),
        answer: () =>
          reply(200, {
            outcome: "preview",
            revision: 0,
            moments: [
              { kind: "lead", at: "2026-11-08T08:00:00Z", passed: true },
              { kind: "overdue", at: "2027-01-01T08:00:00Z", passed: false },
            ],
          }),
      },
    ]);
    withToasts(<RemindersDialog goal={goalDetail()} onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const moments = await screen.findByTestId("goal-reminder-moments");
    expect(within(moments).getAllByRole("listitem")[0]).toHaveTextContent(
      "already passed, will be skipped",
    );
    expect(sent("/reminders", "PUT")[0]).toMatchObject({
      expectedRevision: 0,
      enabled: true,
      leadDays: 3,
      overdueDays: 0,
      atTime: "09:00",
      preview: true,
    });
  });
});

describe("the Goals widget", () => {
  it("offers Mark achieved on a completion goal and stays read-only without rights", async () => {
    const user = userEvent.setup();
    routeFetch([
      {
        when: (url) => url.endsWith("/achievement"),
        answer: () => reply(200, { outcome: "achieved", revision: 2 }),
      },
      {
        when: (url, method) => method === "GET" && url.includes("/goals?"),
        answer: () => reply(200, { list: goalList({ goals: [] }) }),
      },
    ]);
    const { container } = withToasts(
      <GoalsWidgetBody
        home={{ id: HOME, name: "Our flat" }}
        count={5}
        initialList={goalList({
          goals: [
            goalSummary({
              id: ENTRY,
              kind: "completion",
              title: "Paint the shed",
              target: null,
              unit: null,
              unitKind: null,
              total: 0,
              actions: {
                contribute: false,
                setTotal: false,
                achieve: true,
                reopen: false,
                manage: false,
              },
            }),
            goalSummary({
              actions: {
                contribute: false,
                setTotal: false,
                achieve: false,
                reopen: false,
                manage: false,
              },
            }),
          ],
        })}
      />,
    );
    expect(await axeViolations(container)).toEqual([]);
    expect(screen.queryByRole("button", { name: /Add progress to/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mark Paint the shed achieved" }));
    await waitFor(() => {
      expect(sent("/achievement", "POST")).toEqual([{ revision: 3, achieved: true }]);
    });
  });

  it("opens the compact editor with the Home's name", async () => {
    const user = userEvent.setup();
    withToasts(
      <GoalsWidgetBody home={{ id: HOME, name: "Our flat" }} count={5} initialList={goalList()} />,
    );
    await user.click(screen.getByRole("button", { name: "Add progress to Walk to the coast" }));
    expect(screen.getByText(/Now: 7.5 \/ 10 km · Home: Our flat/)).toBeInTheDocument();
  });
});
