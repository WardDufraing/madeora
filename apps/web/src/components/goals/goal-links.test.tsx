// S30c: habit-to-goal links in the interface. The database decides every right, unit, amount and
// recompute (tests/db/rls/habit-goal-links.test.sql); these tests check what people read and choose
// in en and nl, what is sent, a stale preview, and that the views pass automated accessibility checks.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  GOAL,
  HABIT,
  HOME,
  LINK,
  SERIES,
  goalLink,
  goalLinkGoalImpact,
  goalLinkImpact,
  goalSummary,
} from "@/goals/testing";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { LinkArchiveNote } from "./goal-link-notes";
import { GoalLinksSection, HabitLinkedGoals } from "./goal-links";
import { GoalProgressMeter } from "./goal-progress";

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
});

/** Answers by address and method: the first handler whose test matches. */
function routeFetch(
  handlers: readonly {
    readonly when: (url: string, method: string) => boolean;
    readonly answer: (body: Record<string, unknown>) => Promise<Response>;
  }[],
) {
  fetchMock.mockImplementation((input, init) => {
    const url = urlOf(input);
    const method = init?.method ?? "GET";
    const found = handlers.find((handler) => handler.when(url, method));
    return found ? found.answer(bodyOf(init)) : reply(404, { error: "not-found" });
  });
}
function sent(part: string, method: string): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => urlOf(input).includes(part) && (init?.method ?? "GET") === method)
    .map(([, init]) => bodyOf(init));
}

const km = { unit: "km", unitKind: "preset" } as const;
const links = (rows: unknown[]) => ({
  when: (url: string, method: string) => method === "GET" && url.startsWith("/api/v1/goal-links?"),
  answer: () => reply(200, { links: rows }),
});
const candidates = {
  when: (url: string, method: string) =>
    method === "GET" && url.startsWith("/api/v1/goal-links/candidates"),
  answer: () =>
    reply(200, {
      habits: [
        {
          id: HABIT,
          name: "Run",
          unit: "km",
          unitKind: "preset",
          firstStart: "2026-10-01",
          today: "2026-11-10",
        },
      ],
    }),
};

describe("the linked habits of a goal", () => {
  it("shows each link with its start, amount and warnings, in English", async () => {
    routeFetch([
      links([
        goalLink(),
        goalLink({
          id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0098",
          habit: null,
          source: "deleted",
          amount: 3,
          uncountedDays: 2,
          actions: { manage: true, changeStart: false },
        }),
      ]),
    ]);
    const { container } = renderWithQuery(
      <GoalLinksSection target={{ goalId: GOAL }} homeId={HOME} unit={km} canLink />,
    );
    const rows = await screen.findAllByTestId("goal-link");
    expect(rows).toHaveLength(2);
    const [first, second] = rows as [HTMLElement, HTMLElement];
    expect(within(first).getByRole("link", { name: "Run" })).toHaveAttribute(
      "href",
      `/homes/${HOME}/habits/${HABIT}`,
    );
    expect(first).toHaveTextContent("counts from Sunday, November 1, 2026");
    expect(within(first).getByTestId("goal-link-amount")).toHaveTextContent("adds 4.5 km");
    expect(second).toHaveTextContent("Deleted habit");
    expect(within(second).getByTestId("goal-link-source")).toHaveTextContent(
      "The habit was deleted",
    );
    expect(within(second).getByTestId("goal-link-uncounted")).toHaveTextContent(
      "2 days are in a unit that cannot count toward this goal.",
    );
    expect(within(second).queryByTestId("goal-link-change-start")).not.toBeInTheDocument();
    expect(screen.getByTestId("goal-link-habit-open")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows a period's series links read-only, in Dutch", async () => {
    routeFetch([links([goalLink({ goalId: null, seriesId: SERIES })])]);
    renderWithQuery(
      <GoalLinksSection
        target={{ goalId: GOAL }}
        homeId={HOME}
        unit={km}
        canLink={false}
        readOnly
      />,
      "nl",
    );
    expect(await screen.findByText(/telt vanaf/)).toBeInTheDocument();
    expect(screen.getByText(/tellen mee voor elke periode/)).toBeInTheDocument();
    expect(screen.queryByTestId("goal-link-unlink")).not.toBeInTheDocument();
    expect(screen.queryByTestId("goal-link-habit-open")).not.toBeInTheDocument();
  });

  it("shows nothing to a viewer of a goal without links", async () => {
    routeFetch([links([])]);
    const { container } = renderWithQuery(
      <GoalLinksSection target={{ goalId: GOAL }} homeId={HOME} unit={km} canLink={false} />,
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
  });
});

describe("linking a habit", () => {
  it("previews from a chosen start and confirms with the preview's numbers", async () => {
    const user = userEvent.setup();
    routeFetch([
      links([]),
      candidates,
      {
        when: (url, method) => method === "POST" && url === "/api/v1/goal-links",
        answer: (body) =>
          body.preview === true
            ? reply(200, { outcome: "preview", revision: 3, impact: goalLinkImpact() })
            : reply(201, { outcome: "created", link: goalLink(), impact: goalLinkImpact() }),
      },
    ]);
    renderWithQuery(<GoalLinksSection target={{ goalId: GOAL }} homeId={HOME} unit={km} canLink />);
    await user.click(await screen.findByTestId("goal-link-habit-open"));
    const dialog = await screen.findByRole("dialog", { name: "Link a habit" });
    expect(await within(dialog).findByTestId("goal-link-habit")).toHaveDisplayValue("Run");
    await user.selectOptions(within(dialog).getByTestId("goal-link-start"), "beginning");
    expect(within(dialog).getByTestId("goal-link-start")).toHaveDisplayValue(
      "The habit's beginning (Thursday, October 1, 2026)",
    );
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    const impact = await within(dialog).findByTestId("goal-link-impact");
    expect(impact).toHaveTextContent("From this habit: 0 km → 6 km");
    expect(impact).toHaveTextContent("3 / 10 km → 9 / 10 km");
    expect(impact).toHaveTextContent("(90%)");
    expect(impact).toHaveTextContent("manual progress 3 km (unchanged)");
    expect(impact).toHaveTextContent("does not mark the goal achieved");
    await user.click(within(dialog).getByTestId("goal-link-save"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    const [preview, confirm] = sent("/api/v1/goal-links", "POST");
    expect(preview).toMatchObject({
      habitId: HABIT,
      goalId: GOAL,
      start: "beginning",
      preview: true,
    });
    expect(confirm).toMatchObject({
      habitId: HABIT,
      goalId: GOAL,
      start: "beginning",
      startDate: null,
      revision: 3,
      expectedAmount: 6,
    });
    expect(confirm?.id).toBe(preview?.id);
    expect(router.refresh).toHaveBeenCalled();
  });

  it("refuses a chosen date outside the habit's history before asking", async () => {
    const user = userEvent.setup();
    routeFetch([links([]), candidates]);
    renderWithQuery(<GoalLinksSection target={{ goalId: GOAL }} homeId={HOME} unit={km} canLink />);
    await user.click(await screen.findByTestId("goal-link-habit-open"));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByTestId("goal-link-habit");
    await user.selectOptions(within(dialog).getByTestId("goal-link-start"), "date");
    await user.type(within(dialog).getByTestId("goal-link-start-date"), "2026-09-01");
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    expect(
      await within(dialog).findByText(/between the habit's first day and today/),
    ).toBeInTheDocument();
    expect(sent("/api/v1/goal-links", "POST")).toEqual([]);
  });

  it("shows the new numbers when the confirmation is stale", async () => {
    const user = userEvent.setup();
    let confirmations = 0;
    routeFetch([
      links([]),
      candidates,
      {
        when: (url, method) => method === "POST" && url === "/api/v1/goal-links",
        answer: (body) => {
          if (body.preview === true) {
            return reply(200, { outcome: "preview", revision: 3, impact: goalLinkImpact() });
          }
          confirmations += 1;
          return confirmations === 1
            ? reply(409, {
                error: "stale",
                revision: 4,
                impact: goalLinkImpact({ amountAfter: 7.5 }),
              })
            : reply(201, { outcome: "created", link: goalLink() });
        },
      },
    ]);
    renderWithQuery(<GoalLinksSection target={{ goalId: GOAL }} homeId={HOME} unit={km} canLink />);
    await user.click(await screen.findByTestId("goal-link-habit-open"));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByTestId("goal-link-habit");
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    await user.click(await within(dialog).findByTestId("goal-link-save"));
    expect(
      await within(dialog).findByText(/Something changed since the preview/),
    ).toBeInTheDocument();
    expect(within(dialog).getByTestId("goal-link-impact-amount")).toHaveTextContent("7.5 km");
    await user.click(within(dialog).getByTestId("goal-link-save"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(sent("/api/v1/goal-links", "POST").at(-1)).toMatchObject({
      revision: 4,
      expectedAmount: 7.5,
    });
  });

  it("explains when no habit can be linked, in Dutch", async () => {
    const user = userEvent.setup();
    routeFetch([
      links([]),
      {
        when: (url) => url.startsWith("/api/v1/goal-links/candidates"),
        answer: () => reply(200, { habits: [] }),
      },
    ]);
    renderWithQuery(
      <GoalLinksSection target={{ seriesId: SERIES }} homeId={HOME} unit={km} canLink />,
      "nl",
    );
    await user.click(await screen.findByRole("button", { name: "Gewoonte koppelen" }));
    expect(await screen.findByTestId("goal-link-none")).toHaveTextContent(
      "Er kan geen gewoonte worden gekoppeld",
    );
    expect(sent("candidates", "GET")).toHaveLength(1);
    expect(
      urlOf(fetchMock.mock.calls.find(([input]) => urlOf(input).includes("candidates"))?.[0]),
    ).toBe(`/api/v1/goal-links/candidates?seriesId=${SERIES}`);
  });
});

describe("unlinking", () => {
  it("previews keeping the amount, then unlinks", async () => {
    const user = userEvent.setup();
    const impact = goalLinkImpact({
      mode: "keep",
      amountBefore: 4.5,
      amountAfter: 0,
      goals: [
        {
          ...goalLinkGoalImpact(),
          linkedBefore: 4.5,
          linkedAfter: 0,
          totalBefore: 7.5,
          totalAfter: 7.5,
        },
      ],
    });
    routeFetch([
      links([goalLink()]),
      {
        when: (url, method) => method === "POST" && url === `/api/v1/goal-links/${LINK}/unlink`,
        answer: (body) =>
          body.preview === true
            ? reply(200, { outcome: "preview", revision: 2, impact })
            : reply(200, { outcome: "removed", impact }),
      },
    ]);
    const { baseElement } = renderWithQuery(
      <GoalLinksSection target={{ goalId: GOAL }} homeId={HOME} unit={km} canLink />,
    );
    await user.click(await screen.findByTestId("goal-link-unlink"));
    const dialog = await screen.findByRole("dialog", { name: "Unlink Run" });
    expect(within(dialog).getByTestId("goal-unlink-mode")).toHaveDisplayValue(
      "Keep it as manual progress",
    );
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    expect(await within(dialog).findByTestId("goal-link-impact")).toHaveTextContent(
      "7.5 / 10 km → 7.5 / 10 km",
    );
    expect(await axeViolations(baseElement)).toEqual([]);
    await user.click(within(dialog).getByTestId("goal-unlink-save"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(sent(`/goal-links/${LINK}/unlink`, "POST")).toEqual([
      { mode: "keep", preview: true },
      { mode: "keep", revision: 2, expectedAmount: 4.5 },
    ]);
  });

  it("moves a link's start after a preview", async () => {
    const user = userEvent.setup();
    routeFetch([
      links([goalLink()]),
      {
        when: (url, method) => method === "PATCH" && url === `/api/v1/goal-links/${LINK}`,
        answer: (body) =>
          body.preview === true
            ? reply(200, {
                outcome: "preview",
                revision: 1,
                impact: goalLinkImpact({
                  habit: {
                    id: HABIT,
                    name: "Run",
                    unit: "m",
                    unitKind: "preset",
                    firstStart: "2026-10-01",
                    today: "2026-11-10",
                  },
                  startsOn: "2026-11-05",
                  amountBefore: 4.5,
                  amountAfter: 2,
                  goals: [
                    goalLinkGoalImpact({
                      periodStart: "2026-10-01",
                      periodEnd: "2026-10-31",
                      ended: true,
                      totalBefore: 10.5,
                      totalAfter: 8,
                      reachedBefore: true,
                      reachedAfter: false,
                      outcomeBefore: "reached",
                      outcomeAfter: "not_reached",
                    }),
                  ],
                }),
              })
            : reply(200, { outcome: "saved", link: goalLink({ startsOn: "2026-11-05" }) }),
      },
    ]);
    renderWithQuery(<GoalLinksSection target={{ goalId: GOAL }} homeId={HOME} unit={km} canLink />);
    await user.click(await screen.findByTestId("goal-link-change-start"));
    const dialog = await screen.findByRole("dialog");
    const date = within(dialog).getByTestId("goal-link-start-date");
    await user.clear(date);
    await user.type(date, "2026-11-05");
    await user.click(within(dialog).getByRole("button", { name: "Preview" }));
    expect(await within(dialog).findByTestId("goal-link-impact-amount")).toHaveTextContent(
      "4.5 km → 2 km",
    );
    const impact = within(dialog).getByTestId("goal-link-impact");
    expect(impact).toHaveTextContent("each day's total is rounded to three decimals");
    expect(impact).toHaveTextContent("period result Target reached → Target not reached");
    await user.click(within(dialog).getByTestId("goal-link-start-save"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(sent(`/goal-links/${LINK}`, "PATCH").at(-1)).toEqual({
      start: "date",
      startDate: "2026-11-05",
      revision: 1,
      expectedAmount: 2,
    });
  });
});

describe("around the goal and the habit", () => {
  it("says what archiving a linked goal does to its links", async () => {
    routeFetch([
      links([goalLink(), goalLink({ id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0099", amount: 2 })]),
    ]);
    const { container } = renderWithQuery(
      <LinkArchiveNote target={{ goalId: GOAL }} action="archive" unit={km} />,
    );
    const note = await screen.findByTestId("goal-link-archive-note");
    expect(note).toHaveTextContent("2 linked habits add 6.5 km here (Run, Run).");
    expect(note).toHaveTextContent(
      "While the goal is archived, new habit quantities are not added",
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it("names the goals a habit feeds before it is deleted, in Dutch", async () => {
    routeFetch([links([goalLink()])]);
    renderWithQuery(<LinkArchiveNote target={{ habitId: HABIT }} action="delete" />, "nl");
    const note = await screen.findByTestId("goal-link-archive-note");
    expect(note).toHaveTextContent("Deze gewoonte telt mee voor 1 doel:");
    expect(note).toHaveTextContent("Walk to the coast");
    expect(note).toHaveTextContent("tot een doelbeheerder ze ontkoppelt");
  });

  it("says nothing when there are no links", async () => {
    routeFetch([links([])]);
    renderWithQuery(<LinkArchiveNote target={{ habitId: HABIT }} action="archive" />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("goal-link-archive-note")).not.toBeInTheDocument();
  });

  it("breaks a linked goal's progress into its manual and linked parts", () => {
    renderWithQuery(
      <GoalProgressMeter
        goal={goalSummary({ total: 12.5, manualTotal: 3, linkedTotal: 9.5, linkCount: 1 })}
      />,
    );
    expect(screen.getByTestId("goal-progress-breakdown")).toHaveTextContent(
      "Manual: 3 km · From linked habits: 9.5 km",
    );
    expect(screen.getByTestId("goal-over-target")).toHaveTextContent("2.5 km above the target");
  });

  it("lists the goals a habit counts toward", async () => {
    routeFetch([
      links([
        goalLink(),
        goalLink({
          id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0098",
          goalId: null,
          seriesId: SERIES,
          destination: {
            kind: "series",
            id: SERIES,
            title: "Run every month",
            frequency: "monthly",
          },
        }),
      ]),
    ]);
    const { container } = renderWithQuery(<HabitLinkedGoals habitId={HABIT} homeId={HOME} />);
    expect(await screen.findByRole("link", { name: "Walk to the coast" })).toHaveAttribute(
      "href",
      `/homes/${HOME}/goals/${GOAL}`,
    );
    expect(screen.getByRole("link", { name: "Run every month" })).toHaveAttribute(
      "href",
      `/homes/${HOME}/goals/series/${SERIES}`,
    );
    expect(screen.getByTestId("habit-linked-goals")).toHaveTextContent("(Monthly)");
    expect(await axeViolations(container)).toEqual([]);
  });
});
