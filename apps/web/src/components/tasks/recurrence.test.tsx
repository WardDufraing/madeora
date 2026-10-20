// S19: the recurring-task interface. The scope dialog, its preview, the Repeats section with its
// history, and the repeat fields of a new task. The server decides; these tests check what the
// interface sends, what it shows, and that it stays accessible.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { DateTimeFormats } from "@/invitations/format";
import type { OccurrencePage, TaskDetail, TaskSeries } from "@/tasks/api";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { NewTask } from "./new-task";
import { TaskDelete, TaskMove } from "./task-actions";
import { TaskContent } from "./task-content";
import { TaskRepeats } from "./task-repeats";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const HOME = "0b6f6c55-3a4e-4f7a-9f15-9a8a1d0c0001";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";
const TASK = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const EARLIER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021";
const NEXT = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0022";
const BEA = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0042";

const formats: DateTimeFormats = {
  timeZone: "Europe/Brussels",
  dateFormat: "ymd-dash",
  timeFormat: "24h",
  locale: "en",
};
const members = [{ id: BEA, name: "Bea", isSelf: false }];

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): Record<string, unknown> =>
  typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
const urlOf = (input: unknown): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : "";
const callTo = (path: string) => fetchMock.mock.calls.filter(([url]) => urlOf(url).includes(path));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
  router.push.mockClear();
});

function series(extra: Partial<TaskSeries> = {}): TaskSeries {
  return {
    revision: 4,
    frequency: "weekly",
    interval: 1,
    weekdays: [1, 4],
    startsOn: "2026-10-12",
    endsOn: null,
    count: null,
    startOffset: null,
    listId: LIST,
    paused: false,
    ended: false,
    nextDate: "2026-10-19",
    inHead: true,
    detached: false,
    needsReassignment: false,
    assignees: [],
    checklistSize: 0,
    can: { edit: true, assign: false, delete: true },
    ...extra,
  };
}

function occurrence(extra: Partial<TaskDetail> = {}): TaskDetail & { series: TaskSeries } {
  return {
    id: TASK,
    homeId: HOME,
    list: { id: LIST, name: "House", archived: false },
    title: "Water the plants",
    description: null,
    startDate: null,
    dueDate: "2026-10-15",
    priority: null,
    revision: 2,
    needsReassignment: false,
    overdue: false,
    upcoming: false,
    createdAt: "2026-10-12T08:00:00Z",
    createdBy: { me: true, member: null },
    updatedAt: "2026-10-12T08:00:00Z",
    updatedBy: { me: true, member: null },
    completedAt: null,
    completedBy: null,
    reopenedAt: null,
    reopenedBy: null,
    assignees: [],
    labels: [],
    subtasks: [
      {
        id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0061",
        title: "Fill the can",
        completed: false,
        revision: 1,
      },
    ],
    commentCount: 0,
    occurrenceDate: "2026-10-15",
    series: series(),
    can: { edit: true, complete: true, assign: false, delete: true, comment: true },
    ...extra,
  } as TaskDetail & { series: TaskSeries };
}

const changeImpact = {
  scope: "following",
  updated: 3,
  kept: 1,
  removed: 0,
  completed: 2,
  selectedRemoved: false,
  subtasksCopied: 0,
  nextDates: ["2026-10-19", "2026-10-22", "2026-10-26"],
};

describe("NewTask with repeat fields", () => {
  it("describes the schedule in words, needs a due date, and sends it as the first date", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQuery(
      <NewTask
        homeId={HOME}
        lists={[{ id: LIST, name: "House" }]}
        defaultListId={null}
        labels={[]}
        members={[]}
        dateFormat="ymd-dash"
      />,
    );
    await user.click(screen.getByTestId("new-task-open"));
    await user.type(screen.getByLabelText(/Title/), "Water the plants");
    await user.selectOptions(screen.getByLabelText("Repeats"), "weekly");
    expect(screen.getByTestId("repeat-summary")).toHaveTextContent(
      "Choose a due date: it is the first date of the repeat.",
    );
    await user.click(screen.getByRole("button", { name: "Add task" }));
    expect(
      await screen.findByText("A repeating task needs a due date: it is the first date."),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    // Weekly was chosen before the due date, so no weekday is chosen yet: pick two.
    await user.type(screen.getByLabelText("Due date"), "2026-10-15");
    await user.click(screen.getByRole("checkbox", { name: "Monday" }));
    await user.click(screen.getByRole("checkbox", { name: "Thursday" }));
    await user.clear(screen.getByLabelText("Every how many weeks"));
    await user.type(screen.getByLabelText("Every how many weeks"), "2");
    await user.click(screen.getByRole("radio", { name: "After a number of times" }));
    await user.type(screen.getByLabelText("Number of times"), "5");
    const summary = screen.getByTestId("repeat-summary");
    expect(summary).toHaveTextContent("Every 2 weeks on Monday and Thursday, for 5 occurrences");
    expect(summary).toHaveTextContent("Next dates: 2026-10-15, 2026-10-26, and 2026-10-29");
    expect(await axeViolations(container)).toEqual([]);

    fetchMock.mockResolvedValueOnce(
      Response.json({ id: "x", taskId: TASK, revision: 1 }, { status: 201 }),
    );
    await user.click(screen.getByRole("button", { name: "Add task" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      dueDate: "2026-10-15",
      recurrence: {
        frequency: "weekly",
        interval: 2,
        weekdays: [1, 4],
        startsOn: "2026-10-15",
        endsOn: null,
        count: 5,
      },
    });
  });

  it("refuses an interval outside 1 to 99 and a missing weekday", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <NewTask
        homeId={null}
        lists={[{ id: LIST, name: "House" }]}
        defaultListId={null}
        labels={[]}
        members={[]}
        dateFormat="ymd-dash"
      />,
    );
    await user.click(screen.getByTestId("new-task-open"));
    await user.type(screen.getByLabelText(/Title/), "Water");
    await user.type(screen.getByLabelText("Due date"), "2026-10-15");
    await user.selectOptions(screen.getByLabelText("Repeats"), "weekly");
    await user.click(screen.getByRole("checkbox", { name: "Thursday" }));
    await user.clear(screen.getByLabelText("Every how many weeks"));
    await user.type(screen.getByLabelText("Every how many weeks"), "100");
    await user.click(screen.getByRole("button", { name: "Add task" }));
    expect(await screen.findByText("Enter a whole number from 1 to 99.")).toBeInTheDocument();
    expect(screen.getByText("Choose at least one day.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not repeat by default and sends no recurrence", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <NewTask
        homeId={null}
        lists={[{ id: LIST, name: "House" }]}
        defaultListId={null}
        labels={[]}
        members={[]}
        dateFormat="ymd-dash"
      />,
    );
    await user.click(screen.getByTestId("new-task-open"));
    await user.type(screen.getByLabelText(/Title/), "Once");
    fetchMock.mockResolvedValueOnce(Response.json({ id: "x", revision: 1 }, { status: 201 }));
    await user.click(screen.getByRole("button", { name: "Add task" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1]).recurrence).toBeNull();
  });
});

describe("Editing an occurrence", () => {
  it("asks for the scope, previews this and following, then saves that scope", async () => {
    const user = userEvent.setup();
    renderWithQuery(<TaskContent task={occurrence()} labels={[]} dateFormat="ymd-dash" />);
    await user.click(screen.getByTestId("task-edit"));
    await user.clear(screen.getByLabelText(/Title/));
    await user.type(screen.getByLabelText(/Title/), "Water all the plants");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Save changes to which occurrences?",
    });
    expect(within(dialog).getByRole("radio", { name: "Only this occurrence" })).toBeChecked();
    expect(within(dialog).queryByTestId("series-impact")).not.toBeInTheDocument();
    expect(await axeViolations(dialog)).toEqual([]);

    fetchMock.mockResolvedValueOnce(
      Response.json({ outcome: "preview", impact: changeImpact, revision: 4, taskId: TASK }),
    );
    await user.click(within(dialog).getByRole("radio", { name: "This and following occurrences" }));
    const impact = await within(dialog).findByText("3 open occurrences change.");
    expect(impact.closest("[data-testid=series-impact]")).toHaveTextContent(
      "1 occurrence changed on its own stays as it is.",
    );
    expect(screen.getByTestId("series-impact")).toHaveTextContent(
      "2 completed occurrences stay unchanged in the history.",
    );
    const preview = bodyOf(callTo("/series")[0]?.[1]);
    expect(preview).toMatchObject({
      scope: "following",
      dryRun: true,
      expectedTaskRevision: 2,
      expectedSeriesRevision: 4,
      content: { title: "Water all the plants", startOffset: null, copySubtasks: false },
    });
    expect(await axeViolations(dialog)).toEqual([]);

    fetchMock.mockResolvedValue(
      Response.json({ outcome: "saved", impact: changeImpact, revision: 5, taskId: TASK }),
    );
    await user.click(within(dialog).getByTestId("series-scope-confirm"));
    await waitFor(() => {
      expect(screen.getByTestId("live-region")).toHaveTextContent("Task saved.");
    });
    const saved = callTo("/series")
      .map(([, init]) => bodyOf(init))
      .find((body) => body.dryRun === false);
    expect(saved).toMatchObject({ scope: "following", dryRun: false });
    expect(callTo(`/tasks/${TASK}`).some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("changes only this occurrence with the one-task request", async () => {
    const user = userEvent.setup();
    renderWithQuery(<TaskContent task={occurrence()} labels={[]} dateFormat="ymd-dash" />);
    await user.click(screen.getByTestId("task-edit"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    fetchMock.mockResolvedValueOnce(Response.json({ revision: 3 }));
    await user.click(within(dialog).getByTestId("series-scope-confirm"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PATCH");
  });

  it("offers only this occurrence when the due date changed", async () => {
    const user = userEvent.setup();
    renderWithQuery(<TaskContent task={occurrence()} labels={[]} dateFormat="ymd-dash" />);
    await user.click(screen.getByTestId("task-edit"));
    await user.clear(screen.getByLabelText("Due date"));
    await user.type(screen.getByLabelText("Due date"), "2026-10-16");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/You changed the due date/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("radio")).not.toBeInTheDocument();
  });

  it("saves directly when the person may not change the series", async () => {
    const user = userEvent.setup();
    const task = occurrence({
      series: series({ can: { edit: false, assign: false, delete: false } }),
    });
    renderWithQuery(<TaskContent task={task} labels={[]} dateFormat="ymd-dash" />);
    await user.click(screen.getByTestId("task-edit"));
    fetchMock.mockResolvedValueOnce(Response.json({ revision: 3 }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PATCH");
  });

  it("hides this and following for an occurrence of an earlier part of the series", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <TaskContent
        task={occurrence({ series: series({ inHead: false }) })}
        labels={[]}
        dateFormat="ymd-dash"
      />,
    );
    await user.click(screen.getByTestId("task-edit"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("value")),
    ).toEqual(["this", "series"]);
  });
});

describe("A completed occurrence", () => {
  it("does not offer this and following, which the server refuses there", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <TaskContent
        task={occurrence({
          completedAt: "2026-10-15T09:00:00Z",
          completedBy: { me: true, member: null },
        })}
        labels={[]}
        dateFormat="ymd-dash"
      />,
    );
    await user.click(screen.getByTestId("task-edit"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("value")),
    ).toEqual(["this", "series"]);
  });
});

describe("Moving an occurrence", () => {
  const GARDEN = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0011";
  const lists = [
    { id: LIST, name: "House" },
    { id: GARDEN, name: "Garden" },
  ];

  it("previews the entire series and moves the schedule to the other list", async () => {
    const user = userEvent.setup();
    renderWithQuery(<TaskMove task={occurrence()} lists={lists} dateFormat="ymd-dash" />);
    await user.click(screen.getByTestId("task-move"));
    const dialog = await screen.findByRole("dialog", { name: "Move which occurrences?" });
    fetchMock.mockResolvedValueOnce(
      Response.json({
        outcome: "preview",
        impact: { ...changeImpact, scope: "series" },
        revision: 4,
        taskId: TASK,
      }),
    );
    await user.click(within(dialog).getByRole("radio", { name: "All occurrences" }));
    expect(await within(dialog).findByText("3 open occurrences change.")).toBeInTheDocument();
    expect(bodyOf(callTo("/series")[0]?.[1])).toEqual({
      scope: "series",
      dryRun: true,
      expectedTaskRevision: 2,
      expectedSeriesRevision: 4,
      listId: GARDEN,
    });
    expect(await axeViolations(dialog)).toEqual([]);
    fetchMock.mockResolvedValue(
      Response.json({ outcome: "saved", impact: changeImpact, revision: 5, taskId: TASK }),
    );
    await user.click(within(dialog).getByTestId("series-scope-confirm"));
    await waitFor(() => {
      expect(screen.getByTestId("live-region")).toHaveTextContent("Task moved.");
    });
    expect(callTo("/list")).toHaveLength(0);
  });

  it("moves only this occurrence with the one-task request", async () => {
    const user = userEvent.setup();
    renderWithQuery(<TaskMove task={occurrence()} lists={lists} dateFormat="ymd-dash" />);
    await user.click(screen.getByTestId("task-move"));
    const dialog = await screen.findByRole("dialog");
    fetchMock.mockResolvedValueOnce(Response.json({ revision: 3 }));
    await user.click(within(dialog).getByTestId("series-scope-confirm"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(urlOf(fetchMock.mock.calls[0]?.[0])).toContain(`/tasks/${TASK}/list`);
  });

  it("moves directly when the person may not change the series", async () => {
    const user = userEvent.setup();
    const task = occurrence({
      series: series({ can: { edit: false, assign: false, delete: false } }),
    });
    renderWithQuery(<TaskMove task={task} lists={lists} dateFormat="ymd-dash" />);
    fetchMock.mockResolvedValueOnce(Response.json({ revision: 3 }));
    await user.click(screen.getByTestId("task-move"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("Deleting an occurrence", () => {
  it("previews the entire series and moves it to the trash", async () => {
    const user = userEvent.setup();
    renderWithQuery(<TaskDelete task={occurrence()} dateFormat="ymd-dash" />);
    await user.click(screen.getByTestId("task-delete"));
    const dialog = await screen.findByRole("dialog", { name: "Delete which occurrences?" });
    fetchMock.mockResolvedValueOnce(
      Response.json({
        outcome: "preview",
        impact: { scope: "series", removed: 2, completed: 3 },
        trashEntryId: null,
      }),
    );
    await user.click(within(dialog).getByRole("radio", { name: "All occurrences" }));
    expect(
      await within(dialog).findByText(
        "2 open occurrences go to the trash as one item, restorable for 7 days.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("3 completed occurrences stay unchanged in the history."),
    ).toBeInTheDocument();
    expect(await axeViolations(dialog)).toEqual([]);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        outcome: "deleted",
        impact: { scope: "series", removed: 2, completed: 3 },
        trashEntryId: "e",
      }),
    );
    await user.click(within(dialog).getByTestId("series-scope-confirm"));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(`/homes/${HOME}/tasks?list=${LIST}&deleted=1`);
    });
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toEqual({
      scope: "series",
      expectedSeriesRevision: 4,
      dryRun: false,
    });
  });

  it("keeps the confirmation disabled while the preview failed", async () => {
    const user = userEvent.setup();
    renderWithQuery(<TaskDelete task={occurrence()} dateFormat="ymd-dash" />);
    await user.click(screen.getByTestId("task-delete"));
    const dialog = await screen.findByRole("dialog");
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "conflict", revision: 5 }, { status: 409 }),
    );
    await user.click(within(dialog).getByRole("radio", { name: "All occurrences" }));
    expect(
      await within(dialog).findByText(/Someone changed this in the meantime/),
    ).toBeInTheDocument();
    expect(within(dialog).getByTestId("series-scope-confirm")).toBeDisabled();
  });
});

describe("TaskRepeats", () => {
  const history: OccurrencePage = {
    filter: "all",
    total: 3,
    occurrences: [
      {
        id: TASK,
        occurrenceDate: "2026-10-15",
        dueDate: "2026-10-15",
        status: "open",
        completedAt: null,
        completedBy: null,
        current: true,
      },
      {
        id: EARLIER,
        occurrenceDate: "2026-10-12",
        dueDate: "2026-10-12",
        status: "completed_late",
        completedAt: "2026-10-13T08:00:00Z",
        completedBy: { me: false, member: BEA },
        current: false,
      },
      {
        id: NEXT,
        occurrenceDate: "2026-10-08",
        dueDate: "2026-10-08",
        status: "missed",
        completedAt: null,
        completedBy: null,
        current: false,
      },
    ],
  };

  function repeats(task = occurrence()) {
    return renderWithQuery(
      <TaskRepeats
        userId="user-a"
        task={task}
        history={history}
        loadedAt="2026-10-15T10:00:00.000Z"
        members={members}
        formats={formats}
      />,
    );
  }

  it("shows the schedule, the next date and the history with the actual completer", async () => {
    const { container } = repeats();
    expect(screen.getByTestId("series-summary")).toHaveTextContent(
      "Every week on Monday and Thursday",
    );
    expect(screen.getByTestId("series-state")).toHaveTextContent("Next: 2026-10-19");
    const rows = within(screen.getByTestId("series-history")).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("2026-10-15 (this occurrence)");
    expect(rows[1]).toHaveTextContent("Completed late by Bea");
    expect(
      within(rows[1] as HTMLElement).getByRole("link", { name: "2026-10-12" }),
    ).toHaveAttribute("href", `/homes/${HOME}/tasks/${EARLIER}`);
    expect(rows[2]).toHaveTextContent("Missed");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("filters the history by asking the server", async () => {
    const user = userEvent.setup();
    repeats();
    fetchMock.mockResolvedValueOnce(
      Response.json({ filter: "missed", total: 1, occurrences: [history.occurrences[2]] }),
    );
    await user.selectOptions(screen.getByLabelText("Show"), "missed");
    await waitFor(() => {
      expect(within(screen.getByTestId("series-history")).getAllByRole("listitem")).toHaveLength(1);
    });
    expect(urlOf(fetchMock.mock.calls[0]?.[0])).toContain(
      `/tasks/${TASK}/occurrences?filter=missed&offset=0`,
    );
  });

  it("pauses with the series revision and keeps focus on the state", async () => {
    const user = userEvent.setup();
    repeats();
    fetchMock.mockResolvedValueOnce(Response.json({ revision: 5 }));
    await user.click(screen.getByTestId("series-pause"));
    await waitFor(() => {
      expect(screen.getByTestId("series-state")).toHaveFocus();
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      paused: true,
      expectedSeriesRevision: 4,
    });
    await waitFor(() => {
      expect(screen.getByTestId("live-region")).toHaveTextContent("Repeat paused.");
    });
  });

  it("says when it is paused or ended, and hides controls from people who may not change it", () => {
    const { unmount } = repeats(occurrence({ series: series({ paused: true }) }));
    expect(screen.getByTestId("series-state")).toHaveTextContent("Paused.");
    expect(screen.getByTestId("series-pause")).toHaveTextContent("Resume");
    unmount();
    repeats(
      occurrence({
        series: series({
          ended: true,
          nextDate: null,
          can: { edit: false, assign: false, delete: false },
        }),
      }),
    );
    expect(screen.getByTestId("series-state")).toHaveTextContent("This repeat has ended.");
    expect(screen.queryByTestId("series-pause")).not.toBeInTheDocument();
    expect(screen.queryByTestId("series-edit-schedule")).not.toBeInTheDocument();
  });

  it("edits the schedule from this occurrence on, after a preview", async () => {
    const user = userEvent.setup();
    repeats();
    await user.click(screen.getByTestId("series-edit-schedule"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Repeats" }), "daily");
    expect(screen.getByTestId("repeat-summary")).toHaveTextContent("Every day");
    fetchMock.mockResolvedValueOnce(
      Response.json({
        outcome: "preview",
        impact: { ...changeImpact, removed: 2 },
        revision: 4,
        taskId: TASK,
      }),
    );
    await user.click(screen.getByTestId("series-schedule-save"));
    const dialog = await screen.findByRole("dialog", { name: "Change the schedule from where?" });
    expect(
      within(dialog).queryByRole("radio", { name: "Only this occurrence" }),
    ).not.toBeInTheDocument();
    expect(
      await within(dialog).findByText(
        "2 upcoming occurrences are no longer on the schedule and are removed.",
      ),
    ).toBeInTheDocument();
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      scope: "following",
      dryRun: true,
      schedule: { frequency: "daily", interval: 1, weekdays: null, startsOn: "2026-10-12" },
    });
    fetchMock.mockResolvedValueOnce(
      Response.json({ outcome: "saved", impact: changeImpact, revision: 5, taskId: NEXT }),
    );
    await user.click(within(dialog).getByTestId("series-scope-confirm"));
    // The new schedule removed this occurrence: the page shows the next one.
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(`/homes/${HOME}/tasks/${NEXT}`);
    });
  });
});
