import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { DateTimeFormats } from "@/invitations/format";
import type { TaskDetail, TaskListSummary, TaskRow } from "@/tasks/api";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { LabelPicker } from "./label-picker";
import { NewTask } from "./new-task";
import { TaskAssignees } from "./task-assignees";
import { TaskComments } from "./task-comments";
import { TaskCompletion } from "./task-actions";
import { TaskList } from "./task-list";
import { ManageLists } from "./task-manage";
import { TaskSubtasks } from "./task-subtasks";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const HOME = "0b6f6c55-3a4e-4f7a-9f15-9a8a1d0c0001";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";
const TASK = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const ME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0041";
const BEA = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0042";
const LABEL = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0050";

const formats: DateTimeFormats = {
  timeZone: "Europe/Brussels",
  dateFormat: "dmy-slash",
  timeFormat: "24h",
  locale: "en",
};
const members = [
  { id: ME, name: "Ann", isSelf: true },
  { id: BEA, name: "Bea", isSelf: false },
];

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
  router.push.mockClear();
});

function row(extra: Partial<TaskRow> = {}): TaskRow {
  return {
    id: TASK,
    listId: LIST,
    listName: "Renovation",
    title: "Fix the tap",
    startDate: null,
    dueDate: "2026-10-14",
    priority: "urgent",
    completed: false,
    needsReassignment: false,
    overdue: true,
    upcoming: false,
    subtasksDone: 1,
    subtasksTotal: 2,
    commentCount: 3,
    labelIds: [LABEL],
    assigneeIds: [ME, BEA],
    assignedToMe: true,
    canComplete: true,
    revision: 2,
    recurring: false,
    ...extra,
  };
}

function detail(extra: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: TASK,
    homeId: HOME,
    list: { id: LIST, name: "Renovation", archived: false },
    title: "Fix the tap",
    description: null,
    startDate: null,
    dueDate: null,
    priority: null,
    revision: 3,
    needsReassignment: false,
    overdue: false,
    upcoming: false,
    createdAt: "2026-10-15T10:00:00Z",
    createdBy: { me: false, member: BEA },
    updatedAt: "2026-10-15T10:00:00Z",
    updatedBy: { me: false, member: BEA },
    completedAt: null,
    completedBy: null,
    reopenedAt: null,
    reopenedBy: null,
    assignees: [ME, BEA],
    labels: [],
    subtasks: [
      {
        id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0061",
        title: "Buy a washer",
        completed: true,
        revision: 2,
      },
      {
        id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0062",
        title: "Fit it",
        completed: false,
        revision: 1,
      },
    ],
    commentCount: 0,
    occurrenceDate: null,
    series: null,
    can: { edit: true, complete: true, assign: false, delete: false, comment: true },
    ...extra,
  };
}

function taskList(rows: readonly TaskRow[], total = rows.length) {
  return renderWithQuery(
    <TaskList
      userId="user-a"
      homeId={HOME}
      initial={{ tasks: rows, total }}
      query="status=open"
      loadedAt="2026-10-16T10:00:00.000Z"
      labels={[{ id: LABEL, name: "Plumbing", color: "blue" }]}
      members={members}
      dateFormat="dmy-slash"
      showListName
      filtered={false}
      pageSize={50}
    />,
  );
}

describe("TaskList", () => {
  it("shows dates, priority, labels and assignees as text, and has no accessibility violations", async () => {
    const { container } = taskList([row()]);
    const item = await screen.findByTestId("task-row");
    expect(item).toHaveTextContent("Fix the tap");
    expect(item).toHaveTextContent("In Renovation");
    expect(item).toHaveTextContent("Overdue since 14/10/2026");
    expect(item).toHaveTextContent("Priority: Urgent");
    expect(item).toHaveTextContent("1 of 2 subtasks done");
    expect(item).toHaveTextContent("3 comments");
    expect(item).toHaveTextContent("Assigned to You, Bea");
    expect(item).toHaveTextContent("Plumbing");
    expect(screen.getByRole("heading", { name: "1 task" })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("offers no checkbox on a task the viewer may not complete", async () => {
    taskList([row({ canComplete: false })]);
    expect(await screen.findByTestId("task-row")).toHaveTextContent("Open");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("completes for everyone, says who was first, and keeps the keyboard on the list", async () => {
    const user = userEvent.setup();
    taskList([row({ subtasksDone: 2 })]);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        outcome: "already_completed",
        completedAt: "2026-10-16T09:00:00Z",
        completedBy: { me: false, member: BEA },
      }),
    );
    await user.click(await screen.findByRole("checkbox", { name: "Completed: Fix the tap" }));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/tasks/${TASK}/completion`);
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ completed: true });
    await waitFor(() => {
      expect(screen.getByTestId("live-region")).toHaveTextContent(
        "Fix the tap⁩ was already completed by Bea.",
      );
    });
    expect(screen.getByRole("heading", { name: "1 task" })).toHaveFocus();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("asks before completing a task with unfinished subtasks (review H1)", async () => {
    const user = userEvent.setup();
    const { container } = taskList([row()]);
    const box = await screen.findByRole("checkbox", { name: "Completed: Fix the tap" });
    await user.click(box);
    const dialog = await screen.findByRole("dialog", { name: "Complete with open subtasks?" });
    expect(dialog).toHaveTextContent("1 subtask is not done yet.");
    expect(await axeViolations(container)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(box).not.toBeChecked();
    await user.click(box);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        outcome: "completed",
        completedAt: "2026-10-16T09:00:00Z",
        completedBy: { me: true, member: ME },
      }),
    );
    await user.click(await screen.findByTestId("task-list-confirm-complete"));
    await waitFor(() => {
      expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ completed: true });
    });
  });

  it("loads the next page only when asked", async () => {
    const user = userEvent.setup();
    taskList([row()], 2);
    fetchMock.mockResolvedValueOnce(
      Response.json({ tasks: [row({ id: LABEL, title: "Second" })], total: 2 }),
    );
    await user.click(await screen.findByTestId("tasks-more"));
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/tasks?status=open&offset=1&homeId=${HOME}`);
    expect(await screen.findAllByTestId("task-row")).toHaveLength(2);
    expect(screen.queryByTestId("tasks-more")).not.toBeInTheDocument();
  });
});

describe("NewTask", () => {
  it("validates, then sends the task with a client id and empty fields left out", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQuery(
      <NewTask
        homeId={HOME}
        lists={[{ id: LIST, name: "Renovation" }]}
        defaultListId={null}
        labels={[]}
        members={members}
        dateFormat="dmy-slash"
      />,
    );
    await user.click(screen.getByTestId("new-task-open"));
    expect(screen.getByLabelText(/Title/)).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Add task" }));
    expect(await screen.findByText("Enter a name or text.")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Title/), "Paint the hall");
    await user.type(screen.getByLabelText("Start date"), "2026-10-20");
    await user.type(screen.getByLabelText("Due date"), "2026-10-18");
    await user.click(screen.getByRole("button", { name: "Add task" }));
    expect(
      await screen.findByText("The due date cannot be before the start date."),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await axeViolations(container)).toEqual([]);

    await user.clear(screen.getByLabelText("Due date"));
    await user.click(screen.getByRole("checkbox", { name: "Bea" }));
    fetchMock.mockResolvedValueOnce(Response.json({ id: "x", revision: 1 }, { status: 201 }));
    await user.click(screen.getByRole("button", { name: "Add task" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const body = bodyOf(fetchMock.mock.calls[0]?.[1]) as Record<string, unknown>;
    expect(body).toMatchObject({
      homeId: HOME,
      listId: LIST,
      title: "Paint the hall",
      description: null,
      startDate: "2026-10-20",
      dueDate: null,
      priority: null,
      labelIds: [],
      assigneeIds: [BEA],
    });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => {
      expect(screen.getByTestId("live-region")).toHaveTextContent("Task added.");
    });
  });

  it("cannot be opened without a list", () => {
    renderWithQuery(
      <NewTask
        homeId={null}
        lists={[]}
        defaultListId={null}
        labels={[]}
        members={[]}
        dateFormat="dmy-slash"
      />,
    );
    expect(screen.getByTestId("new-task-open")).toBeDisabled();
  });
});

describe("TaskCompletion", () => {
  it("asks before completing with open subtasks, then names the completer", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQuery(
      <TaskCompletion task={detail()} members={members} formats={formats} />,
    );
    expect(screen.getByTestId("task-status")).toHaveTextContent("Not completed");
    await user.click(screen.getByTestId("task-complete"));
    const dialog = await screen.findByRole("dialog", { name: "Complete with open subtasks?" });
    expect(dialog).toHaveTextContent("1 subtask is not done yet.");
    expect(await axeViolations(container)).toEqual([]);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        outcome: "completed",
        completedAt: "2026-10-16T09:00:00Z",
        completedBy: { me: true, member: ME },
      }),
    );
    await user.click(within(dialog).getByTestId("task-confirm-complete"));
    await waitFor(() => {
      expect(screen.getByTestId("task-status")).toHaveFocus();
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ completed: true });
  });

  it("shows who completed it, distinct from the assignees", () => {
    renderWithQuery(
      <TaskCompletion
        task={detail({
          completedAt: "2026-10-16T09:00:00Z",
          completedBy: { me: false, member: BEA },
        })}
        members={members}
        formats={formats}
      />,
    );
    expect(screen.getByTestId("task-status")).toHaveTextContent(
      "Completed by Bea on 16/10/2026 11:00",
    );
    expect(screen.getByTestId("task-complete")).toHaveTextContent("Reopen");
  });

  it("tells a member without the right instead of offering the button", () => {
    renderWithQuery(
      <TaskCompletion
        task={detail({
          can: { edit: false, complete: false, assign: false, delete: false, comment: true },
        })}
        members={members}
        formats={formats}
      />,
    );
    expect(screen.queryByTestId("task-complete")).not.toBeInTheDocument();
    expect(screen.getByText(/Only its creator, its assignees/)).toBeInTheDocument();
  });

  it("says who reopened an open task and when (review M4)", () => {
    renderWithQuery(
      <TaskCompletion
        task={detail({
          reopenedAt: "2026-10-16T09:00:00Z",
          reopenedBy: { me: false, member: BEA },
        })}
        members={members}
        formats={formats}
      />,
    );
    expect(screen.getByTestId("task-status")).toHaveTextContent(
      "Not completed: reopened by Bea on 16/10/2026 11:00",
    );
  });

  it("names a departed completer without a name", () => {
    renderWithQuery(
      <TaskCompletion
        task={detail({
          completedAt: "2026-10-16T09:00:00Z",
          completedBy: { me: false, member: null },
        })}
        members={members}
        formats={formats}
      />,
    );
    expect(screen.getByTestId("task-status")).toHaveTextContent("Completed by A former member");
  });
});

describe("TaskSubtasks", () => {
  it("is read-only for someone who may not edit the task", async () => {
    const { container } = renderWithQuery(
      <TaskSubtasks
        task={detail({
          can: { edit: false, complete: false, assign: false, delete: false, comment: true },
        })}
      />,
    );
    expect(screen.getByTestId("subtask-progress")).toHaveTextContent("1 of 2 subtasks done");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByTestId("subtask-new")).not.toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("ticks at once, reorders with buttons and announces each change", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQuery(<TaskSubtasks task={detail()} />);
    expect(await axeViolations(container)).toEqual([]);
    fetchMock.mockResolvedValue(Response.json({ revision: 2 }));
    await user.click(screen.getByRole("checkbox", { name: "Fit it" }));
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ completed: true });
    const region = screen.getByTestId("live-region");
    await waitFor(() => {
      expect(region).toHaveTextContent("Fit it⁩ done.");
    });
    expect(screen.getByRole("checkbox", { name: "Fit it" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Move Fit it up" }));
    await waitFor(() => {
      expect(bodyOf(fetchMock.mock.calls.at(-1)?.[1])).toEqual({
        ids: ["6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0062", "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0061"],
      });
    });
  });

  it("confirms before removing and returns focus to the checklist", async () => {
    const user = userEvent.setup();
    renderWithQuery(<TaskSubtasks task={detail()} />);
    await user.click(screen.getByRole("button", { name: "Remove Fit it" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove subtask?" });
    fetchMock.mockResolvedValueOnce(Response.json({}));
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Subtasks" })).toHaveFocus();
    });
  });
});

describe("TaskComments", () => {
  const comment = (id: string, mine: boolean, body: string) => ({
    id,
    body,
    createdAt: "2026-10-15T10:00:00Z",
    editedAt: mine ? "2026-10-15T11:00:00Z" : null,
    revision: 1,
    author: { me: mine, member: mine ? ME : BEA },
  });

  it("lists comments oldest first; only one's own can be edited or deleted", async () => {
    const { container } = renderWithQuery(
      <TaskComments
        userId="user-a"
        taskId={TASK}
        initial={{
          comments: [comment(LIST, false, "Which shop?"), comment(LABEL, true, "The big one")],
          total: 2,
        }}
        loadedAt="2026-10-16T10:00:00.000Z"
        members={members}
        formats={formats}
      />,
    );
    const items = screen.getAllByTestId("task-comment");
    expect(items[0]).toHaveTextContent("Bea");
    expect(items[0]).toHaveTextContent("Which shop?");
    expect(within(items[0] as HTMLElement).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(items[1]).toHaveTextContent("You");
    expect(items[1]).toHaveTextContent("edited 15/10/2026 13:00");
    expect(
      within(items[1] as HTMLElement).getByRole("button", { name: "Edit" }),
    ).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("refuses a blank comment and sends a real one once with its id", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <TaskComments
        userId="user-a"
        taskId={TASK}
        initial={{ comments: [], total: 0 }}
        loadedAt="2026-10-16T10:00:00.000Z"
        members={members}
        formats={formats}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add comment" }));
    expect(await screen.findByText("Enter a name or text.")).toBeInTheDocument();
    await user.type(screen.getByTestId("comment-new"), "Saturday?");
    fetchMock.mockResolvedValueOnce(Response.json({ id: "x", revision: 1 }, { status: 201 }));
    // The page refetches comments afterwards; the comment itself is sent once.
    fetchMock.mockResolvedValue(Response.json({ comments: [], total: 0 }));
    await user.click(screen.getByRole("button", { name: "Add comment" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({ body: "Saturday?" });
  });
});

describe("TaskAssignees", () => {
  it("shows assignees to everyone; only task managers get the change button", async () => {
    const { container, unmount } = renderWithQuery(
      <TaskAssignees task={detail()} members={members} dateFormat="dmy-slash" />,
    );
    expect(screen.getByTestId("task-assignees")).toHaveTextContent("You");
    expect(screen.getByTestId("task-assignees")).toHaveTextContent("Bea");
    expect(screen.queryByTestId("task-assignees-edit")).not.toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
    unmount();
    renderWithQuery(
      <TaskAssignees
        task={detail({
          needsReassignment: true,
          can: { edit: true, complete: true, assign: true, delete: true, comment: true },
        })}
        members={members}
        dateFormat="dmy-slash"
      />,
    );
    expect(screen.getByText(/This task needs reassignment/)).toBeInTheDocument();
    expect(screen.getByTestId("task-assignees-edit")).toBeInTheDocument();
  });
});

describe("ManageLists", () => {
  const list = (extra: Partial<TaskListSummary>): TaskListSummary => ({
    id: LIST,
    name: "Renovation",
    position: 0,
    archived: false,
    revision: 1,
    openTasks: 2,
    activeTasks: 3,
    ...extra,
  });

  it("explains what is in the way before deleting a list with tasks", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQuery(<ManageLists homeId={HOME} lists={[list({})]} />);
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Delete Renovation" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete list?" });
    expect(dialog).toHaveTextContent("This list still has 3 tasks.");
    expect(within(dialog).queryByTestId("manage-list-confirm-delete")).not.toBeInTheDocument();
  });

  it("reports a refused archive with its count", async () => {
    const user = userEvent.setup();
    renderWithQuery(<ManageLists homeId={HOME} lists={[list({})]} />);
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "has-open-tasks", count: 2 }, { status: 409 }),
    );
    await user.click(screen.getByRole("button", { name: "Archive Renovation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This list still has 2 open tasks.");
  });
});

describe("LabelPicker", () => {
  it("filters many labels by name and lists the chosen ones as text", async () => {
    const user = userEvent.setup();
    const labels = ["Garden", "Garage", "Kitchen", "Bills", "School", "Car", "Pets"].map(
      (name, index) => ({
        id: `6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00${String(70 + index)}`,
        name,
        color: null,
      }),
    );
    const onChange = vi.fn();
    const { container } = renderWithQuery(
      <LabelPicker labels={labels} value={[labels[2]?.id ?? ""]} onChange={onChange} />,
    );
    expect(screen.getByText("1 label chosen")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Find a label"), "gar");
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    await user.click(screen.getByRole("checkbox", { name: "Garage" }));
    expect(onChange).toHaveBeenCalledWith([labels[2]?.id, labels[1]?.id]);
    await act(async () => {
      expect(await axeViolations(container)).toEqual([]);
    });
  });
});
