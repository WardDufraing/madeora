// S29: numeric habits in the interface. The database decides targets, units and totals
// (tests/db/rls/numeric-habits.test.sql); these tests check what people type and read in nl and en,
// what is sent, and how refusals read.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { ToastProvider } from "@/components/ui/toast";
import type { HabitList } from "@/habits/api";
import { defaultTrackingDraft, type TrackingDraft } from "@/habits/tracking-draft";
import {
  HABIT,
  HOME,
  MEMBER,
  habitSummary,
  numericDay,
  numericHabitDetail,
  numericHabitSummary,
} from "@/habits/testing";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { HabitDetailView } from "./habit-detail";
import { QuickAddsDialog, TrackingChangeDialog } from "./habit-numeric-dialogs";
import { HabitProgressCard, ProgressEntry, QuickAddButtons } from "./habit-progress";
import { NumericSummaries } from "./habit-numeric-summaries";
import { HabitProgressWidgetBody } from "./habit-widget-body";
import { TrackingFields } from "./numeric-fields";
import { HabitsView } from "./habits-view";

function numericProgress(): NonNullable<ReturnType<typeof numericHabitSummary>["progress"]> {
  const progress = numericHabitSummary().progress;
  if (!progress) throw new Error("fixture has no progress");
  return progress;
}

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/habits" }));

const CONTRIBUTION = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00c1";

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
/** The first request sent to an address that includes `part` with `method`. */
function sent(part: string, method: string): Record<string, unknown> | undefined {
  const call = fetchMock.mock.calls.find(
    ([input, init]) => urlOf(input).includes(part) && (init?.method ?? "GET") === method,
  );
  return call ? bodyOf(call[1]) : undefined;
}
const detailRead = (habit: unknown) => ({
  when: (url: string, method: string) => method === "GET" && url.endsWith(`/habits/${HABIT}`),
  answer: () => reply(200, { habit }),
});

function withToasts(ui: React.ReactElement, locale: "en" | "nl" = "en") {
  return renderWithQuery(
    <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss">
      {ui}
    </ToastProvider>,
    locale,
  );
}

const added = (extra: Record<string, unknown> = {}) => ({
  outcome: "added",
  contributionId: CONTRIBUTION,
  completedNow: false,
  progress: numericHabitSummary().progress,
  streakBefore: 3,
  milestone: null,
  habit: numericHabitSummary(),
  ...extra,
});

describe("entering progress in the viewer's locale", () => {
  it("reads 1.5 in English and sends an exact decimal string", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => reply(200, added()));
    const habit = numericHabitSummary({
      tracking: { ...numericHabitSummary().tracking, unit: "l", target: 2, quickAdds: [] },
    });
    const { container } = withToasts(<ProgressEntry habit={habit} />);
    expect(await axeViolations(container)).toEqual([]);
    const field = screen.getByRole("textbox", { name: "Add progress" });
    await user.type(field, "1.5");
    expect(screen.getByText(/Will be saved as 1\.5\./)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add progress" }));
    const call = fetchMock.mock.calls[0];
    expect(urlOf(call?.[0])).toBe(`/api/v1/habits/${HABIT}/contributions`);
    expect(bodyOf(call?.[1])).toMatchObject({ quantity: "1.5", onDate: null, enteredUnit: null });
    expect(await screen.findAllByText("1.5 L added to Drink water")).not.toHaveLength(0);
    // The field is empty again for the next amount.
    await waitFor(() => {
      expect(field).toHaveValue("");
    });
  });

  it("reads 1,5 in Dutch and sends the same exact decimal string", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => reply(200, added()));
    const habit = numericHabitSummary({
      tracking: { ...numericHabitSummary().tracking, unit: "l", target: 2, quickAdds: [] },
    });
    withToasts(<ProgressEntry habit={habit} />, "nl");
    await user.type(screen.getByRole("textbox", { name: "Voortgang toevoegen" }), "1,5");
    expect(screen.getByText(/Wordt opgeslagen als 1,5\./)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Voortgang toevoegen" }));
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({ quantity: "1.5" });
  });

  it("refuses the other locale's separator, with its own words, and sends nothing", async () => {
    const user = userEvent.setup();
    const nl = withToasts(<ProgressEntry habit={numericHabitSummary()} />, "nl");
    await user.type(screen.getByRole("textbox", { name: "Voortgang toevoegen" }), "1.5");
    expect(
      await screen.findByText("Schrijf decimalen met een komma, bijvoorbeeld 1,5."),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Voortgang toevoegen" }));
    nl.unmount();
    const en = withToasts(<ProgressEntry habit={numericHabitSummary()} />, "en");
    await user.type(screen.getByRole("textbox", { name: "Add progress" }), "1,5");
    expect(await screen.findByText("Write decimals with a point, for example 1.5.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add progress" }));
    expect(await axeViolations(en.container)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not guess at thousands separators, signs, exponents or too many decimals", async () => {
    const user = userEvent.setup();
    withToasts(<ProgressEntry habit={numericHabitSummary()} />, "nl");
    const field = screen.getByRole("textbox", { name: "Voortgang toevoegen" });
    const cases: [string, string][] = [
      ["1.500", "Schrijf decimalen met een komma"],
      ["1.234,5", "Vul een getal in met cijfers"],
      ["-5", "Vul een getal in met cijfers"],
      ["1e3", "Vul een getal in met cijfers"],
      ["1,2345", "Gebruik hooguit 3 decimalen."],
      ["0", "De hoeveelheid moet groter zijn dan nul."],
      ["2000000", "De hoeveelheid mag hooguit 1.000.000 zijn."],
    ];
    for (const [text, message] of cases) {
      await user.clear(field);
      await user.type(field, text);
      expect(await screen.findByText(new RegExp(message.replace(".", "\\.")))).toBeVisible();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for an amount when submitted empty, and refuses fractions of a whole unit", async () => {
    const user = userEvent.setup();
    const glasses = numericHabitSummary({
      tracking: {
        ...numericHabitSummary().tracking,
        unit: "glasses",
        target: 8,
        quickAdds: [1, 2],
      },
    });
    withToasts(<ProgressEntry habit={glasses} />);
    await user.click(screen.getByRole("button", { name: "Add progress" }));
    expect(await screen.findByText("Enter an amount.")).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "Add progress" }), "1.5");
    expect(await screen.findByText("This unit takes whole numbers only.")).toBeVisible();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds to an earlier day when given its date", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => reply(200, added()));
    withToasts(<ProgressEntry habit={numericHabitSummary()} onDate="2026-11-08" />);
    await user.type(screen.getByRole("textbox", { name: "Add progress" }), "300");
    await user.click(screen.getByRole("button", { name: "Add progress" }));
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      quantity: "300",
      onDate: "2026-11-08",
    });
  });
});

describe("entering progress in another unit", () => {
  it("offers only units of the same kind and shows the exact conversion before saving", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => reply(200, added()));
    withToasts(<ProgressEntry habit={numericHabitSummary()} />, "nl");
    const unit = screen.getByRole("combobox", { name: "Invullen in" });
    expect(
      Array.from((unit as HTMLSelectElement).options).map((option) => option.textContent),
    ).toEqual(["Milliliter (ml)", "Liter (l)"]);
    await user.selectOptions(unit, "l");
    await user.type(screen.getByRole("textbox", { name: "Voortgang toevoegen" }), "1,5");
    expect(screen.getByText("Telt als 1.500 ml.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Voortgang toevoegen" }));
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      quantity: "1.5",
      enteredUnit: "l",
    });
  });

  it("blocks a conversion that would lose decimals, before and after the database answers", async () => {
    const user = userEvent.setup();
    const litres = numericHabitSummary({
      tracking: { ...numericHabitSummary().tracking, unit: "l", target: 2, quickAdds: [] },
    });
    withToasts(<ProgressEntry habit={litres} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Enter in" }), "ml");
    await user.type(screen.getByRole("textbox", { name: "Add progress" }), "1.5");
    // 1.5 mL is 0.0015 L: four decimals, so it cannot be saved exactly.
    expect(screen.getByTestId("habit-progress-conversion")).toHaveTextContent(
      "That would be 0.002 L after rounding",
    );
    expect(screen.getByRole("button", { name: "Add progress" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the rounded amount when the database refuses a conversion", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => reply(409, { error: "precision", converted: 0.123 }));
    withToasts(<ProgressEntry habit={numericHabitSummary()} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Enter in" }), "l");
    await user.type(screen.getByRole("textbox", { name: "Add progress" }), "1");
    await user.click(screen.getByRole("button", { name: "Add progress" }));
    expect(await screen.findByText(/That would be 0\.123 mL after rounding/)).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("quick-add buttons", () => {
  it("add one preset with one tap and offer Undo, which undoes exactly that contribution", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((_input, init) =>
      init?.method === "PATCH"
        ? reply(200, { outcome: "undone", reopened: false, habit: numericHabitSummary() })
        : reply(200, added()),
    );
    const { container } = withToasts(
      <QuickAddButtons habit={numericHabitSummary()} source="app" />,
    );
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Add 250 mL to Drink water" }));
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      quantity: "250",
      source: "app",
      revision: null,
    });
    const toast = await screen.findAllByText("250 mL added to Drink water");
    expect(toast).not.toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(urlOf(fetchMock.mock.calls[1]?.[0])).toBe(`/api/v1/habit-contributions/${CONTRIBUTION}`);
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toMatchObject({ action: "undo" });
    expect(await screen.findAllByText("Progress removed from Drink water")).not.toHaveLength(0);
  });

  it("tell the widget's habit revision, so a stale preset is refused, and say when it was", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() =>
      reply(409, { error: "stale", habit: numericHabitSummary() }),
    );
    withToasts(
      <QuickAddButtons habit={numericHabitSummary({ revision: 7 })} source="widget" compact />,
    );
    await user.click(screen.getByRole("button", { name: "Add 500 mL to Drink water" }));
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({ source: "widget", revision: 7 });
    expect(
      await screen.findByText("This changed in the meantime. Check the details and try again."),
    ).toBeVisible();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("announce the target and the new streak when the last tap completes the day", async () => {
    const user = userEvent.setup();
    const done = numericHabitSummary({
      streak: { current: 4, unit: "occurrences", longestOccurrences: 5, longestWeeks: 0 },
    });
    fetchMock.mockImplementation(() => reply(200, added({ completedNow: true, habit: done })));
    withToasts(<QuickAddButtons habit={numericHabitSummary()} source="app" />);
    await user.click(screen.getByRole("button", { name: "Add 500 mL to Drink water" }));
    expect(await screen.findAllByText("Target reached for Drink water")).not.toHaveLength(0);
    expect(await screen.findAllByText(/3.*4/)).not.toHaveLength(0);
  });

  it("show nothing for a habit without presets", () => {
    const { container } = withToasts(
      <QuickAddButtons
        habit={numericHabitSummary({
          tracking: { ...numericHabitSummary().tracking, quickAdds: [] },
        })}
        source="app"
      />,
    );
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("the habit list and the widget", () => {
  function renderList(habits = [numericHabitSummary()]) {
    const list: HabitList = {
      habits,
      counts: { active: habits.length, ended: 0, archived: 0 },
      access: "manage",
      memberAccess: null,
      celebrations: true,
      timeZone: "Europe/Brussels",
    };
    return withToasts(
      <HabitsView
        homeId={null}
        view="active"
        query=""
        initialList={list}
        members={[{ id: MEMBER, name: "Ann", isSelf: true }]}
        today="2026-11-10"
        weekStart="monday"
        timeZone="Europe/Brussels"
        timeZones={["Europe/Brussels"]}
      />,
    );
  }

  it("shows the amount against the target and Open instead of Complete", async () => {
    const { container } = renderList();
    expect(screen.getByTestId("habit-progress-text")).toHaveTextContent("500 / 2,000 mL");
    expect(
      screen.getByRole("progressbar", { name: "Progress of Drink water today" }),
    ).toHaveAttribute("aria-valuenow", "500");
    expect(screen.queryByRole("button", { name: /Complete/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Drink water" })).toHaveAttribute(
      "href",
      `/homes/${HOME}/habits/${HABIT}`,
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it("keeps a binary habit's Complete next to a numeric one", () => {
    renderList([numericHabitSummary(), habitSummary({ name: "Stretch" })]);
    expect(screen.getAllByRole("button", { name: /Complete/ })).toHaveLength(1);
  });

  it("caps the bar at the target and states the excess in words", () => {
    const over = numericHabitSummary({
      progress: {
        ...numericProgress(),
        total: 2250,
        met: true,
        above: true,
      },
    });
    renderList([over]);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2000");
    expect(screen.getByTestId("habit-progress-text")).toHaveTextContent("2,250 / 2,000 mL");
    expect(screen.getByTestId("habit-progress-above")).toHaveTextContent(
      "250 mL above the target. Extra does not carry over to the next day.",
    );
  });

  it("says why nothing can be added today and offers no buttons", () => {
    renderList([
      numericHabitSummary({ progress: null, contributionBlock: "paused", todayState: "paused" }),
    ]);
    expect(screen.getByTestId("habit-today-state")).toHaveTextContent("The habit is paused.");
    expect(screen.queryByRole("link", { name: /Open/ })).not.toBeInTheDocument();
  });

  it("gives a view-only member the totals without any way to add", () => {
    renderList([numericHabitSummary({ access: "view" })]);
    expect(screen.getByTestId("habit-progress-text")).toBeVisible();
    expect(screen.queryByRole("link", { name: /Open/ })).not.toBeInTheDocument();
  });

  it("puts the quick-add buttons in the Habit progress widget and says when the habit is gone", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((input) =>
      urlOf(input).includes("/contributions")
        ? reply(200, added())
        : reply(200, { habit: numericHabitDetail() }),
    );
    const { container } = withToasts(
      <HabitProgressWidgetBody initialHabit={numericHabitDetail()} />,
    );
    expect(screen.getByTestId("habit-progress-text")).toHaveTextContent("500 / 2,000 mL");
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Add 250 mL to Drink water" }));
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({ source: "widget", revision: 1 });
  });

  it("shows an ended habit in the widget without buttons", () => {
    withToasts(
      <HabitProgressWidgetBody
        initialHabit={numericHabitDetail({
          status: "ended",
          progress: null,
          contributionBlock: "archived",
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: /Add/ })).not.toBeInTheDocument();
  });
});

describe("choosing how a habit is tracked", () => {
  function Harness({ weekly = false }: { readonly weekly?: boolean }) {
    const [draft, setDraft] = useState<TrackingDraft>(defaultTrackingDraft("en"));
    return <TrackingFields value={draft} onChange={setDraft} weekly={weekly} />;
  }

  it("reveals the unit, target and presets for a numeric target and restarts presets with the unit", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQuery(<Harness />);
    expect(screen.queryByRole("textbox", { name: "Daily target" })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Tracking" }), "numeric");
    expect(screen.getByRole("textbox", { name: "Daily target" })).toBeVisible();
    expect(screen.getByText(/For example: 3 \/ 8 glasses/)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Preset 1" })).toHaveValue("1");
    await user.selectOptions(screen.getByRole("combobox", { name: "Unit" }), "ml");
    expect(screen.getByRole("textbox", { name: "Preset 1" })).toHaveValue("250");
    expect(screen.getByText(/For example: 500 \/ 2,000 mL/)).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("asks for a label with a custom unit and never offers a weekly target", async () => {
    const user = userEvent.setup();
    renderWithQuery(<Harness />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Tracking" }), "numeric");
    await user.selectOptions(screen.getByRole("combobox", { name: "Unit" }), "custom");
    expect(screen.getByRole("textbox", { name: "Unit label" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Preset 1" })).not.toBeInTheDocument();
    expect(screen.queryByText(/week/i)).not.toBeInTheDocument();
  });

  it("limits the presets to five and removes one at a time", async () => {
    const user = userEvent.setup();
    renderWithQuery(<Harness />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Tracking" }), "numeric");
    const add = screen.getByRole("button", { name: "Add preset" });
    for (let i = 0; i < 5; i += 1) await user.click(add);
    expect(screen.getAllByRole("textbox", { name: /Preset/ })).toHaveLength(5);
    expect(add).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Remove preset 1" }));
    expect(screen.getAllByRole("textbox", { name: /Preset/ })).toHaveLength(4);
    expect(add).toBeEnabled();
  });

  it("disables the numeric choice for a weekly schedule and explains why", () => {
    renderWithQuery(<Harness weekly />);
    expect(screen.getByRole("combobox", { name: "Tracking" })).toBeDisabled();
    expect(screen.getByText(/needs a daily or weekdays schedule/)).toBeVisible();
  });
});

describe("changing the target", () => {
  const impact = {
    old: { mode: "numeric", target: 2000, unit: "ml", unitKind: "preset" },
    new: { mode: "numeric", target: 500, unit: "ml", unitKind: "preset" },
    effectiveOn: "2026-11-10",
    relation: "same",
    converted: null,
    today: { total: 500, completedBefore: false, completedAfter: true, statusChange: true },
    nextDates: ["2026-11-11"],
    currentStreak: { current: 3, unit: "occurrences" },
    reminders: false,
  };

  it("previews a start today, asks to confirm a flipped status and sends today's total", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((_input, init) =>
      bodyOf(init).preview === true
        ? reply(200, { outcome: "preview", impact, revision: 1 })
        : reply(200, { outcome: "saved", impact, revision: 2 }),
    );
    const onClose = vi.fn();
    const { baseElement } = withToasts(
      <TrackingChangeDialog habit={numericHabitDetail()} onClose={onClose} />,
    );
    expect(await axeViolations(baseElement)).toEqual([]);
    const target = screen.getByRole("textbox", { name: "Daily target" });
    await user.clear(target);
    await user.type(target, "500");
    await user.selectOptions(screen.getByRole("combobox", { name: "Applies from" }), "today");
    await user.click(screen.getByRole("button", { name: "Show preview" }));
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      preview: true,
      when: "today",
      expectedTotal: 500,
      tracking: { target: 500, unit: "ml" },
    });
    expect(await screen.findByTestId("habit-tracking-preview")).toHaveTextContent(
      "Tracking changes from 2,000 mL to 500 mL on",
    );
    expect(screen.getByTestId("habit-tracking-today")).toHaveTextContent(
      "Today's total is 500. With the new target, today becomes completed.",
    );
    const confirm = screen.getByRole("button", { name: "Confirm change" });
    expect(confirm).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", { name: "I understand today's completion changes." }),
    );
    await user.click(confirm);
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toMatchObject({
      preview: false,
      confirmStatus: true,
      when: "today",
    });
  });

  it("offers a start today only while the unit stays the same", async () => {
    const user = userEvent.setup();
    withToasts(<TrackingChangeDialog habit={numericHabitDetail()} onClose={vi.fn()} />);
    const when = screen.getByRole("combobox", { name: "Applies from" });
    expect(Array.from((when as HTMLSelectElement).options).map((o) => o.value)).toEqual([
      "today",
      "next",
      "date",
    ]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Unit" }), "l");
    expect(Array.from((when as HTMLSelectElement).options).map((o) => o.value)).toEqual([
      "next",
      "date",
    ]);
  });

  it("makes the person confirm that incompatible units are not converted", async () => {
    const user = userEvent.setup();
    const incompatible = {
      ...impact,
      new: { mode: "numeric", target: 8, unit: "glasses", unitKind: "preset" },
      relation: "incompatible",
      today: null,
    };
    fetchMock.mockImplementation(() =>
      reply(200, { outcome: "preview", impact: incompatible, revision: 1 }),
    );
    withToasts(<TrackingChangeDialog habit={numericHabitDetail()} onClose={vi.fn()} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Unit" }), "glasses");
    const target = screen.getByRole("textbox", { name: "Daily target" });
    await user.clear(target);
    await user.type(target, "8");
    await user.click(screen.getByRole("button", { name: "Show preview" }));
    expect(await screen.findByText(/These units cannot be converted/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirm change" })).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", {
        name: "I understand the old and new units are not converted.",
      }),
    );
    expect(screen.getByRole("button", { name: "Confirm change" })).toBeEnabled();
  });

  it("says when a change would change nothing and when today's total moved", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementationOnce(() => reply(409, { error: "unchanged", revision: 1 }));
    withToasts(<TrackingChangeDialog habit={numericHabitDetail()} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Show preview" }));
    expect(await screen.findByText("Nothing would change.")).toBeVisible();
    fetchMock.mockImplementationOnce(() => reply(409, { error: "stale", impact, revision: 1 }));
    await user.click(screen.getByRole("button", { name: "Show preview" }));
    expect(
      await screen.findByText("This changed in the meantime. Check the details and try again."),
    ).toBeVisible();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("reads the target in Dutch and refuses a point as the decimal separator", async () => {
    const user = userEvent.setup();
    withToasts(<TrackingChangeDialog habit={numericHabitDetail()} onClose={vi.fn()} />, "nl");
    const target = screen.getByRole("textbox", { name: "Dagelijks doel" });
    await user.clear(target);
    await user.type(target, "2.5");
    await user.click(screen.getByRole("button", { name: "Voorbeeld tonen" }));
    expect(
      await screen.findByText("Schrijf decimalen met een komma, bijvoorbeeld 1,5."),
    ).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("quick-add preset editing", () => {
  it("saves the presets as exact decimals and refuses a duplicate", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => reply(200, { revision: 2 }));
    const onClose = vi.fn();
    withToasts(<QuickAddsDialog habit={numericHabitSummary()} onClose={onClose} />, "nl");
    const first = screen.getByRole("textbox", { name: "Snelknop 1" });
    await user.clear(first);
    await user.type(first, "500");
    await user.click(screen.getByRole("button", { name: "Opslaan" }));
    expect(await screen.findByText("Deze hoeveelheid is al een snelknop.")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.clear(first);
    await user.type(first, "0,125");
    await user.click(screen.getByRole("button", { name: "Opslaan" }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(urlOf(fetchMock.mock.calls[0]?.[0])).toBe(`/api/v1/habits/${HABIT}/quick-adds`);
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      revision: 1,
      quickAdds: ["0.125", "500"],
    });
  });
});

describe("the habit page", () => {
  function renderPage(detail = numericHabitDetail()) {
    return withToasts(
      <HabitDetailView
        initialHabit={detail}
        initialInsights={null}
        initialCalendar={null}
        days={30}
        month="2026-11"
        members={[{ id: MEMBER, name: "Ann", isSelf: true }]}
        timeZones={["Europe/Brussels"]}
      />,
    );
  }

  it("shows the progress card, the daily totals with their notes and the tracking history", async () => {
    fetchMock.mockImplementation(() => reply(200, {}));
    const detail = numericHabitDetail({
      numericRecent: [
        numericDay({ onDate: "2026-11-10", total: 500, met: false, above: false, state: "open" }),
        numericDay({ note: "Hot day", noteRevision: 1 }),
      ],
      recent: [
        {
          onDate: "2026-11-10",
          state: "open",
          kind: "daily",
          pausedBy: null,
          block: null,
          checkin: null,
        },
        {
          onDate: "2026-11-09",
          state: "completed",
          kind: "daily",
          pausedBy: null,
          block: null,
          checkin: null,
        },
      ],
    });
    const { container } = renderPage(detail);
    expect(screen.getByTestId("habit-progress-card")).toBeVisible();
    const days = screen.getAllByTestId("habit-numeric-day");
    expect(days).toHaveLength(2);
    expect(days[1]).toHaveTextContent("2,250 / 2,000 mL");
    expect(days[1]).toHaveTextContent("Target exceeded");
    expect(days[1]).toHaveTextContent("Hot day");
    expect(screen.getByTestId("habit-trackings")).toHaveTextContent("2,000 mL per day");
    // A numeric day never offers the binary Complete.
    expect(screen.queryByTestId("habit-day-complete")).not.toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("lets a member without management review only their own contributions and add no note", () => {
    renderPage(
      numericHabitDetail({
        access: "complete",
        numericRecent: [numericDay()],
        recent: [
          {
            onDate: "2026-11-09",
            state: "completed",
            kind: "daily",
            pausedBy: null,
            block: null,
            checkin: null,
          },
        ],
      }),
    );
    expect(
      screen.getByRole("button", { name: "Review contributions for Mon, Nov 9" }),
    ).toHaveTextContent("My contributions");
    expect(screen.queryByTestId("habit-day-note-edit")).not.toBeInTheDocument();
    expect(screen.queryByTestId("habit-change-tracking")).not.toBeInTheDocument();
  });

  it("offers a manager the tracking change and the presets editor", () => {
    renderPage();
    expect(screen.getByTestId("habit-change-tracking")).toBeVisible();
    expect(screen.getByTestId("habit-edit-quick-adds")).toBeVisible();
  });

  it("reviews a day's contributions for a manager with who added each, and corrects one", async () => {
    const user = userEvent.setup();
    const contributions = {
      onDate: "2026-11-09",
      all: true,
      target: 2000,
      unit: "ml",
      unitKind: "preset",
      total: 2250,
      contributions: [
        {
          id: CONTRIBUTION,
          onDate: "2026-11-09",
          quantity: 250,
          originalQuantity: null,
          enteredQuantity: null,
          enteredUnit: null,
          by: MEMBER,
          mine: true,
          recordedAt: "2026-11-09T08:00:00Z",
          source: "app",
          status: "active",
          amendedAt: null,
          undoneAt: null,
          undoKind: null,
          undoReason: null,
          action: "undo",
        },
      ],
    };
    const detail = numericHabitDetail({
      numericRecent: [numericDay()],
      recent: [
        {
          onDate: "2026-11-09",
          state: "completed",
          kind: "daily",
          pausedBy: null,
          block: null,
          checkin: null,
        },
      ],
    });
    routeFetch([
      detailRead(detail),
      {
        when: (_url, method) => method === "PATCH",
        answer: () => reply(200, { outcome: "undone", habit: numericHabitSummary() }),
      },
      {
        when: (url) => url.includes("/contributions"),
        answer: () => reply(200, { contributions }),
      },
    ]);
    renderPage(detail);
    await user.click(screen.getByTestId("habit-day-review"));
    const row = await screen.findByTestId("habit-contribution");
    expect(row).toHaveTextContent("250 mL");
    expect(row).toHaveTextContent("you");
    expect(sent("/contributions?on=2026-11-09", "GET")).toBeDefined();
    await user.click(screen.getByTestId("habit-contribution-undo"));
    await waitFor(() => {
      expect(sent(`/habit-contributions/${CONTRIBUTION}`, "PATCH")).toMatchObject({
        action: "undo",
      });
    });
  });

  it("amends a contribution with a localized quantity", async () => {
    const user = userEvent.setup();
    const contribution = {
      id: CONTRIBUTION,
      onDate: "2026-11-09",
      quantity: 250,
      originalQuantity: null,
      enteredQuantity: null,
      enteredUnit: null,
      by: MEMBER,
      mine: false,
      recordedAt: "2026-11-09T08:00:00Z",
      source: "app",
      status: "active",
      amendedAt: null,
      undoneAt: null,
      undoKind: null,
      undoReason: null,
      action: "correct",
    };
    const detail = numericHabitDetail({
      numericRecent: [numericDay()],
      recent: [
        {
          onDate: "2026-11-09",
          state: "completed",
          kind: "daily",
          pausedBy: null,
          block: null,
          checkin: null,
        },
      ],
    });
    routeFetch([
      detailRead(detail),
      {
        when: (_url, method) => method === "PATCH",
        answer: () => reply(200, { outcome: "corrected", habit: numericHabitSummary() }),
      },
      {
        when: (url) => url.includes("/contributions"),
        answer: () =>
          reply(200, {
            contributions: {
              onDate: "2026-11-09",
              all: true,
              target: 2000,
              unit: "ml",
              unitKind: "preset",
              total: 250,
              contributions: [contribution],
            },
          }),
      },
    ]);
    renderPage(detail);
    await user.click(screen.getByTestId("habit-day-review"));
    await user.click(await screen.findByTestId("habit-contribution-amend"));
    const field = screen.getByRole("textbox", { name: "Corrected amount" });
    expect(field).toHaveValue("250");
    await user.clear(field);
    await user.type(field, "300");
    await user.click(screen.getByTestId("habit-amend-save"));
    await waitFor(() => {
      expect(sent(`/habit-contributions/${CONTRIBUTION}`, "PATCH")).toMatchObject({
        action: "amend",
        quantity: "300",
      });
    });
  });

  it("saves the day note with its revision", async () => {
    const user = userEvent.setup();
    const detail = numericHabitDetail({
      numericRecent: [numericDay({ note: "Hot day", noteRevision: 1 })],
      recent: [
        {
          onDate: "2026-11-09",
          state: "completed",
          kind: "daily",
          pausedBy: null,
          block: null,
          checkin: null,
        },
      ],
    });
    routeFetch([
      detailRead(detail),
      { when: (_url, method) => method === "PUT", answer: () => reply(200, { revision: 2 }) },
    ]);
    renderPage(detail);
    await user.click(screen.getByTestId("habit-day-note-edit"));
    const note = screen.getByTestId("habit-day-note-text");
    expect(note).toHaveValue("Hot day");
    await user.clear(note);
    await user.type(note, "Very hot");
    await user.click(screen.getByTestId("habit-day-note-save"));
    await waitFor(() => {
      expect(sent(`/habits/${HABIT}/day-notes/2026-11-09`, "PUT")).toEqual({
        revision: 1,
        note: "Very hot",
      });
    });
  });

  it("adds progress to an earlier day it still accepts, and not to one it no longer does", async () => {
    const user = userEvent.setup();
    const detail = numericHabitDetail({
      numericRecent: [
        numericDay({
          onDate: "2026-11-09",
          total: 900,
          met: false,
          above: false,
          state: "missed",
        }),
        numericDay({ onDate: "2026-11-02", block: "outside_window" }),
      ],
      recent: [
        {
          onDate: "2026-11-09",
          state: "missed",
          kind: "daily",
          pausedBy: null,
          block: null,
          checkin: null,
        },
        {
          onDate: "2026-11-02",
          state: "missed",
          kind: "daily",
          pausedBy: null,
          block: "outside_window",
          checkin: null,
        },
      ],
    });
    routeFetch([
      detailRead(detail),
      { when: (_url, method) => method === "POST", answer: () => reply(200, added()) },
    ]);
    renderPage(detail);
    const buttons = screen.getAllByTestId("habit-day-add-progress");
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0] as HTMLElement);
    const dialog = within(screen.getByRole("dialog"));
    await user.type(dialog.getByRole("textbox", { name: "Add progress" }), "600");
    await user.click(dialog.getByRole("button", { name: "Add progress" }));
    await waitFor(() => {
      expect(sent("/contributions", "POST")).toMatchObject({
        quantity: "600",
        onDate: "2026-11-09",
      });
    });
  });
});

describe("the progress card", () => {
  it("shows the add controls while progress can be added", () => {
    withToasts(<HabitProgressCard habit={numericHabitSummary()} />);
    expect(screen.getByTestId("habit-progress-form")).toBeVisible();
  });

  it("shows why nothing can be added instead of the controls", () => {
    withToasts(
      <HabitProgressCard
        habit={numericHabitSummary({ progress: null, contributionBlock: "not_scheduled" })}
      />,
    );
    expect(screen.queryByTestId("habit-progress-form")).not.toBeInTheDocument();
    expect(screen.getByTestId("habit-today-state")).toHaveTextContent(
      "The habit is not scheduled today.",
    );
  });
});

describe("quantity summaries", () => {
  it("lists weekly and monthly totals, averages per eligible day and met days, units apart", async () => {
    const { container } = withToasts(
      <NumericSummaries
        summary={{
          periods: [
            {
              kind: "week",
              startsOn: "2026-11-09",
              endsOn: "2026-11-15",
              soFar: true,
              segments: [
                {
                  unit: "ml",
                  unitKind: "preset",
                  total: 5500,
                  eligibleDays: 2,
                  metDays: 1,
                  average: 2750,
                },
                {
                  unit: "glasses",
                  unitKind: "preset",
                  total: 9,
                  eligibleDays: 2,
                  metDays: 1,
                  average: 4.5,
                },
              ],
            },
            {
              kind: "week",
              startsOn: "2026-11-02",
              endsOn: "2026-11-08",
              soFar: false,
              segments: [],
            },
            {
              kind: "month",
              startsOn: "2026-11-01",
              endsOn: "2026-11-30",
              soFar: true,
              segments: [
                {
                  unit: "ml",
                  unitKind: "preset",
                  total: 5500,
                  eligibleDays: 10,
                  metDays: 3,
                  average: 550,
                },
              ],
            },
          ],
        }}
      />,
    );
    const text = screen.getByTestId("habit-numeric-summaries");
    expect(text).toHaveTextContent("Weekly totals");
    expect(text).toHaveTextContent("Monthly totals");
    expect(text).toHaveTextContent(
      "Total 5,500 mL · average 2,750 mL per eligible day · target met on 1 of 2 days",
    );
    expect(text).toHaveTextContent("Total 9 glasses · average 4.5 glasses per eligible day");
    expect(text).toHaveTextContent("so far");
    expect(text).toHaveTextContent("No eligible days");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("formats the same totals with Dutch separators", () => {
    withToasts(
      <NumericSummaries
        summary={{
          periods: [
            {
              kind: "week",
              startsOn: "2026-11-09",
              endsOn: "2026-11-15",
              soFar: false,
              segments: [
                {
                  unit: "l",
                  unitKind: "preset",
                  total: 12.5,
                  eligibleDays: 7,
                  metDays: 5,
                  average: 1.786,
                },
              ],
            },
          ],
        }}
      />,
      "nl",
    );
    expect(screen.getByTestId("habit-numeric-summaries")).toHaveTextContent(
      "Totaal 12,5 l · gemiddeld 1,786 l per dag waarop het kon · doel gehaald op 5 van 7 dagen",
    );
  });
});
