// S30b: recurring goals in the interface. The database decides every right, period and outcome
// (tests/db/rls/recurring-goals.test.sql); these tests check what people read and type in en and nl,
// what is sent, and that the views pass automated accessibility checks.
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ToastProvider } from "@/components/ui/toast";
import {
  GOAL,
  HOME,
  SERIES,
  goalDetail,
  goalList,
  goalPeriod,
  goalSeriesDetail,
  goalSummary,
} from "@/goals/testing";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { RemindersDialog } from "./goal-dialogs";
import { GoalDetailView } from "./goal-detail";
import { GoalFormDialog } from "./goal-form-dialog";
import { GoalSeriesView } from "./goal-series";
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

const periods = {
  when: (url: string, method: string) => method === "GET" && url.includes("/periods"),
  answer: () =>
    reply(200, {
      periods: {
        periods: [
          goalSummary({ period: goalPeriod(), total: 7.5 }),
          goalSummary({
            id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0099",
            status: "achieved",
            total: 9,
            period: goalPeriod({
              start: "2026-10-01",
              end: "2026-10-31",
              ended: true,
              outcome: "not_reached",
              correctedAt: "2026-11-02T10:00:00Z",
              needsReview: true,
            }),
          }),
        ],
        hasMore: false,
      },
    }),
};

/** The series as read again after a change. */
const seriesRead = {
  when: (url: string, method: string) => method === "GET" && url.endsWith(`/goal-series/${SERIES}`),
  answer: () => reply(200, { series: goalSeriesDetail() }),
};

describe("recurring goals in the list", () => {
  it("shows a period's frequency badge and the Recurring section, and passes axe", async () => {
    const list = goalList({
      goals: [goalSummary({ period: goalPeriod() })],
      series: [goalSeriesDetail()],
    });
    const { container } = withToasts(
      <GoalsView
        homeId={HOME}
        view="active"
        query=""
        initialList={list}
        today="2026-11-10"
        timeZone="Europe/Brussels"
        timeZones={[]}
        weekStart="monday"
      />,
    );
    expect(screen.getByTestId("goal-card")).toHaveTextContent("Monthly");
    expect(screen.getByRole("heading", { name: "Recurring" })).toBeInTheDocument();
    const card = screen.getByTestId("goal-series-card");
    expect(card).toHaveTextContent("Monthly · Active");
    expect(card).toHaveTextContent("7.5 / 10 km");
    expect(screen.getByRole("link", { name: "Run every month" })).toHaveAttribute(
      "href",
      `/homes/${HOME}/goals/series/${SERIES}`,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("a period's goal page", () => {
  it("names its period and series, and shows an ended period's corrected outcome", () => {
    routeFetch([]);
    withToasts(
      <GoalDetailView
        initialGoal={goalDetail({
          status: "ended",
          period: goalPeriod({
            ended: true,
            outcome: "reached",
            correctedAt: "2026-12-02T10:00:00Z",
          }),
        })}
        members={[]}
        contexts={[]}
        timeZone="Europe/Brussels"
        timeZones={[]}
      />,
    );
    expect(screen.getByTestId("goal-period-line")).toHaveTextContent(/Period .* \(Monthly\)/);
    expect(screen.getByRole("link", { name: "Run every month" })).toHaveAttribute(
      "href",
      `/homes/${HOME}/goals/series/${SERIES}`,
    );
    expect(screen.getByText(/Result: Target reached · corrected/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change target" })).not.toBeInTheDocument();
  });

  it("flags an achieved period that a correction took below its target, in Dutch", () => {
    routeFetch([]);
    withToasts(
      <GoalDetailView
        initialGoal={goalDetail({
          status: "achieved",
          achievedAt: "2026-11-30T10:00:00Z",
          period: goalPeriod({ ended: true, outcome: "not_reached", needsReview: true }),
        })}
        members={[]}
        contexts={[]}
        timeZone="Europe/Brussels"
        timeZones={[]}
      />,
      "nl",
    );
    expect(screen.getByTestId("goal-needs-review")).toHaveTextContent(/^Nakijken/);
  });

  it("offers advance reminders only for a period", () => {
    withToasts(<RemindersDialog goal={goalDetail({ period: goalPeriod() })} onClose={() => {}} />);
    expect(screen.getByTestId("goal-reminders-lead")).toBeInTheDocument();
    expect(screen.queryByTestId("goal-reminders-overdue")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/overdue/i)).not.toBeInTheDocument();
  });
});

describe("creating a recurring goal", () => {
  it("previews the first and next periods before creating, and goes to the series", async () => {
    const user = userEvent.setup();
    routeFetch([
      {
        when: (url, method) =>
          method === "POST" &&
          url.endsWith("/goal-series") &&
          sent("/goal-series", "POST").length === 1,
        answer: () =>
          reply(200, {
            id: SERIES,
            outcome: "preview",
            startsNow: true,
            periods: {
              first: { start: "2026-11-01", end: "2026-11-30" },
              next: { start: "2026-12-01", end: "2026-12-31" },
            },
          }),
      },
      {
        when: (url, method) => method === "POST" && url.endsWith("/goal-series"),
        answer: () => reply(201, { id: SERIES, outcome: "created", revision: 1 }),
      },
    ]);
    const { container } = withToasts(
      <GoalFormDialog
        mode={{ kind: "create", homeId: null }}
        contexts={[]}
        today="2026-11-10"
        timeZone="Europe/Brussels"
        timeZones={["Europe/Brussels"]}
        weekStart="sunday"
        onClose={() => {}}
      />,
    );
    await user.type(screen.getByLabelText(/Title/), "Run every month");
    await user.selectOptions(screen.getByLabelText("Unit"), "km");
    await user.type(screen.getByLabelText(/^Target/), "40");
    await user.selectOptions(screen.getByLabelText(/Repeat/), "monthly");
    expect(screen.queryByLabelText(/Progress so far/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Week starts on/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Preview periods" }));
    expect(await screen.findByTestId("goal-series-preview")).toHaveTextContent(
      "The first period starts now.",
    );
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Create recurring goal" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(expect.stringMatching(/^\/goals\/series\//));
    });
    const [preview, created] = sent("/goal-series", "POST");
    expect(preview).toMatchObject({
      homeId: null,
      kind: "measurable",
      frequency: "monthly",
      measure: { target: 40, unit: "km", unitKind: "preset" },
      firstPeriod: "2026-11-10",
      timeZone: "Europe/Brussels",
      preview: true,
    });
    expect(created).toMatchObject({ preview: false });
  });

  it("asks for a new preview after a change, and offers weekly only for measurable goals", async () => {
    const user = userEvent.setup();
    routeFetch([
      {
        when: (url, method) => method === "POST" && url.endsWith("/goal-series"),
        answer: () =>
          reply(200, {
            id: SERIES,
            outcome: "preview",
            startsNow: false,
            periods: { first: { start: "2026-11-15", end: "2026-11-21" }, next: null },
          }),
      },
    ]);
    withToasts(
      <GoalFormDialog
        mode={{ kind: "create", homeId: null }}
        contexts={[]}
        today="2026-11-10"
        timeZone="Europe/Brussels"
        timeZones={["Europe/Brussels"]}
        weekStart="sunday"
        onClose={() => {}}
      />,
    );
    await user.type(screen.getByLabelText(/Title/), "Read");
    await user.type(screen.getByLabelText(/^Target/), "100");
    await user.selectOptions(screen.getByLabelText(/Repeat/), "weekly");
    expect(screen.getByLabelText(/Week starts on/)).toHaveValue("sunday");
    await user.click(screen.getByRole("button", { name: "Preview periods" }));
    expect(await screen.findByTestId("goal-series-preview")).toHaveTextContent(
      "This is the only period",
    );
    await user.type(screen.getByLabelText(/^Title/), "ing");
    expect(screen.queryByTestId("goal-series-preview")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview periods" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/Type/), "completion");
    expect(screen.getByText("Weekly repetition is for measurable goals.")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Weekly" })).not.toBeInTheDocument();
  });
});

describe("the series page", () => {
  function page(series = goalSeriesDetail(), locale: "en" | "nl" = "en") {
    return withToasts(
      <GoalSeriesView initialSeries={series} members={[]} timeZones={["Europe/Brussels"]} />,
      locale,
    );
  }

  it("shows the current period, the target schedule and the period history, and passes axe", async () => {
    routeFetch([periods]);
    const { container } = page();
    expect(screen.getByTestId("goal-series-state")).toHaveTextContent("Active");
    expect(screen.getByTestId("goal-series-current")).toHaveTextContent("7.5 / 10 km");
    expect(screen.getByTestId("goal-series-targets")).toHaveTextContent("10 km");
    const rows = await screen.findAllByTestId("goal-series-period");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("running");
    expect(rows[1]).toHaveTextContent("Target not reached · corrected · Achieved · needs review");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("pauses with the revision as read, and hides the manager actions from viewers", async () => {
    const user = userEvent.setup();
    routeFetch([
      periods,
      {
        when: (url, method) => method === "GET" && url.endsWith(`/goal-series/${SERIES}`),
        answer: () => reply(200, { series: goalSeriesDetail({ state: "paused", revision: 2 }) }),
      },
      {
        when: (url, method) => method === "POST" && url.endsWith("/state"),
        answer: () => reply(200, { id: SERIES, revision: 2 }),
      },
    ]);
    const { unmount } = page();
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => {
      expect(sent("/state", "POST")).toEqual([{ revision: 1, action: "pause" }]);
    });
    unmount();
    page(
      goalSeriesDetail({
        access: "view",
        actions: { manage: false, changeTarget: false, pause: false, resume: false, stop: false },
      }),
    );
    expect(screen.queryByTestId("goal-series-actions")).not.toBeInTheDocument();
  });

  it("schedules a target for the next period by default after a preview", async () => {
    const user = userEvent.setup();
    const impact = {
      effectiveFrom: "2026-12-01",
      until: null,
      current: false,
      targetBefore: 10,
      targetAfter: 12,
      unitBefore: "km",
      unitKindBefore: "preset",
      unitAfter: "km",
      unitKindAfter: "preset",
      unitChanged: false,
      goalId: null,
      total: null,
      reachedBefore: null,
      reachedAfter: null,
      achieved: false,
      reopens: false,
      reminders: false,
    };
    routeFetch([
      periods,
      seriesRead,
      {
        when: (url, method) =>
          method === "POST" && url.endsWith("/target") && sent("/target", "POST").length === 1,
        answer: () => reply(200, { outcome: "preview", revision: 1, impact }),
      },
      {
        when: (url, method) => method === "POST" && url.endsWith("/target"),
        answer: () => reply(200, { outcome: "saved", revision: 2 }),
      },
    ]);
    page();
    await user.click(screen.getByRole("button", { name: "Change target" }));
    expect(screen.getByLabelText("Applies from")).toHaveValue("next");
    const target = screen.getByTestId("goal-series-target-value");
    await user.clear(target);
    await user.type(target, "12");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByTestId("goal-series-target-impact")).toHaveTextContent(
      "The current and earlier periods keep their target.",
    );
    await user.click(screen.getByTestId("goal-series-target-save"));
    await waitFor(() => {
      expect(sent("/target", "POST")).toHaveLength(2);
    });
    expect(sent("/target", "POST")[1]).toMatchObject({
      revision: 1,
      effectiveFrom: "2026-12-01",
      target: "12",
      unit: "km",
      confirmStatus: false,
    });
  });

  it("asks to confirm a current-period change that flips Target reached", async () => {
    const user = userEvent.setup();
    const impact = {
      effectiveFrom: "2026-11-01",
      until: null,
      current: true,
      targetBefore: 10,
      targetAfter: 7,
      unitBefore: "km",
      unitKindBefore: "preset",
      unitAfter: "km",
      unitKindAfter: "preset",
      unitChanged: false,
      goalId: GOAL,
      total: 7.5,
      reachedBefore: false,
      reachedAfter: true,
      achieved: false,
      reopens: false,
      reminders: false,
    };
    routeFetch([
      periods,
      seriesRead,
      {
        when: (url, method) => method === "POST" && url.endsWith("/target"),
        answer: () => reply(200, { outcome: "preview", revision: 1, impact }),
      },
    ]);
    page();
    await user.click(screen.getByRole("button", { name: "Change target" }));
    await user.selectOptions(screen.getByLabelText("Applies from"), "current");
    const target = screen.getByTestId("goal-series-target-value");
    await user.clear(target);
    await user.type(target, "7");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByTestId("goal-series-target-impact")).toHaveTextContent("7.5 / 10 km");
    expect(sent("/target", "POST")[0]).toMatchObject({ effectiveFrom: "2026-11-01" });
    expect(screen.getByTestId("goal-series-target-save")).toBeDisabled();
    await user.click(screen.getByTestId("goal-series-confirm-status"));
    expect(screen.getByTestId("goal-series-target-save")).toBeEnabled();
  });

  it("explains a stopped series without a running period, in Dutch", () => {
    routeFetch([periods]);
    page(
      goalSeriesDetail({
        state: "stopped",
        current: null,
        actions: { manage: true, changeTarget: false, pause: false, resume: false, stop: false },
      }),
      "nl",
    );
    expect(screen.getByTestId("goal-series-current")).toHaveTextContent(
      "Gestopt: er beginnen geen nieuwe periodes meer.",
    );
    expect(screen.queryByRole("button", { name: "Bewerken" })).not.toBeInTheDocument();
  });
});
