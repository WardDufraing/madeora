import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { DateTimeFormats } from "@/invitations/format";
import type { BulkResponse, TaskReminderView, TaskRow, TaskTemplate } from "@/tasks/api";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { TaskList } from "./task-list";
import { TaskReminderSection } from "./task-reminder";
import {
  FromTemplate,
  SaveAsTemplate,
  type SaveAsTemplateProps,
  TemplateLibrary,
} from "./task-templates";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const HOME = "0b6f6c55-3a4e-4f7a-9f15-9a8a1d0c0001";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";
const LIST_B = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0011";
const TASK = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const TASK_B = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021";
const TEMPLATE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0030";
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
const labels = [{ id: LABEL, name: "Plumbing", color: "blue" as const }];

type Route = (init: RequestInit | undefined) => { status: number; body: unknown };
const routes = new Map<string, Route>();
const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;
const callsTo = (method: string, url: string) =>
  fetchMock.mock.calls.filter(([input, init]) => input === url && init?.method === method);

beforeEach(() => {
  routes.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation((input, init) => {
    const route = routes.get(
      `${init?.method ?? "GET"} ${typeof input === "string" ? input : input instanceof URL ? input.href : input.url}`,
    );
    const answer = route ? route(init) : { status: 500, body: { error: "failed" } };
    return Promise.resolve(Response.json(answer.body, { status: answer.status }));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
});

function view(extra: Partial<TaskReminderView> = {}): TaskReminderView {
  return {
    taskId: TASK,
    dueDate: "2027-03-28",
    completed: false,
    recurring: false,
    canEdit: true,
    canEditSeries: false,
    timeZone: "Europe/Brussels",
    reminder: null,
    seriesReminder: null,
    recipients: [BEA],
    recipientsAreAssignees: true,
    channels: { inApp: true, email: false },
    ...extra,
  };
}

const scheduled = {
  mode: "relative" as const,
  localAt: null,
  daysBefore: 1,
  time: "09:00",
  timeZone: "Europe/Brussels",
  fireAt: "2027-03-27T08:00:00+00:00",
  dst: null,
  status: "scheduled" as const,
  own: true,
  revision: 2,
  reviewFireAt: null,
  reviewDst: null,
};

function reminder(extra: Partial<TaskReminderView> = {}) {
  return renderWithQuery(
    <TaskReminderSection
      view={view(extra)}
      members={members}
      formats={formats}
      today="2027-03-20"
    />,
  );
}

describe("TaskReminderSection", () => {
  it("says when it reminds, who and how, with no accessibility violations", async () => {
    const { container } = reminder({ reminder: scheduled });
    const section = screen.getByTestId("task-reminder");
    expect(section).toHaveTextContent("Reminds around 27/03/2027 09:00 (Europe/Brussels).");
    expect(section).toHaveTextContent("1 day before the due date at 09:00.");
    expect(section).toHaveTextContent("It reminds the people assigned at that moment: Bea.");
    expect(section).toHaveTextContent("You get reminders here in the app.");
    expect(section).toHaveTextContent("up to 5 minutes");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("warns when reminders are switched off, with a link to the settings", () => {
    reminder({ reminder: scheduled, channels: { inApp: false, email: false } });
    expect(screen.getByRole("link", { name: "Open notification settings" })).toHaveAttribute(
      "href",
      "/settings/notifications",
    );
  });

  it("previews the server's time with its DST case, then saves for this task", async () => {
    const user = userEvent.setup();
    routes.set(`PUT /api/v1/tasks/${TASK}/reminder`, (init) => {
      const body = bodyOf(init) as { dryRun: boolean };
      return body.dryRun
        ? {
            status: 200,
            body: {
              outcome: "preview",
              fireAt: "2027-03-28T01:30:00+00:00",
              dst: "gap",
              impact: null,
              revision: 0,
            },
          }
        : {
            status: 200,
            body: {
              outcome: "saved",
              fireAt: "2027-03-28T01:30:00+00:00",
              dst: "gap",
              impact: null,
              revision: 1,
            },
          };
    });
    reminder();
    expect(screen.getByText("No reminder.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Set a reminder" }));
    const form = screen.getByRole("form", { name: "Reminder" });
    await user.click(within(form).getByRole("radio", { name: "At a date and time" }));
    const date = within(form).getByLabelText("Date");
    await user.clear(date);
    await user.type(date, "2027-03-28");
    const time = within(form).getByLabelText("Time");
    await user.clear(time);
    await user.type(time, "02:30");
    const preview = within(form).getByTestId("reminder-preview");
    await waitFor(() => {
      expect(preview).toHaveTextContent(
        "It will remind around 28/03/2027 03:30 (Europe/Brussels).",
      );
    });
    expect(preview).toHaveTextContent("clocks go forward");
    await user.click(within(form).getByRole("button", { name: "Save reminder" }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    const sent = callsTo("PUT", `/api/v1/tasks/${TASK}/reminder`).map(([, init]) => bodyOf(init));
    expect(sent.at(-1)).toEqual({
      mode: "absolute",
      localAt: "2027-03-28T02:30",
      scope: "this",
      expectedRevision: 0,
      expectedSeriesRevision: null,
      dryRun: false,
    });
  });

  it("explains a time in the past from the preview", async () => {
    const user = userEvent.setup();
    routes.set(`PUT /api/v1/tasks/${TASK}/reminder`, () => ({
      status: 409,
      body: { error: "in-past" },
    }));
    reminder();
    await user.click(screen.getByRole("button", { name: "Set a reminder" }));
    await waitFor(() => {
      expect(screen.getByTestId("reminder-preview")).toHaveTextContent("already passed");
    });
  });

  it("asks which occurrences get a reminder before the due date, showing the impact", async () => {
    const user = userEvent.setup();
    routes.set(`PUT /api/v1/tasks/${TASK}/reminder`, (init) => {
      const body = bodyOf(init) as { scope: string; dryRun: boolean };
      if (body.scope === "this") {
        return {
          status: 200,
          body: {
            outcome: "preview",
            fireAt: "2027-03-27T08:00:00+00:00",
            dst: null,
            impact: null,
            revision: 0,
          },
        };
      }
      return {
        status: 200,
        body: {
          outcome: body.dryRun ? "preview" : "saved",
          fireAt: "2027-03-27T08:00:00+00:00",
          dst: null,
          impact: { scope: body.scope, updated: 3, kept: 1, past: 1, completed: 2 },
          revision: 1,
        },
      };
    });
    const { baseElement } = reminder({
      recurring: true,
      canEditSeries: true,
      seriesReminder: { active: false, daysBefore: null, time: null, revision: 4 },
    });
    await user.click(screen.getByRole("button", { name: "Set a reminder" }));
    await user.click(screen.getByRole("button", { name: "Save reminder" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Which occurrences get this reminder?",
    });
    await user.click(within(dialog).getByRole("radio", { name: "All occurrences" }));
    const impact = within(dialog).getByTestId("reminder-impact");
    await waitFor(() => {
      expect(impact).toHaveTextContent("3 open occurrences get this reminder.");
    });
    expect(impact).toHaveTextContent("1 occurrence keeps the reminder set for it alone.");
    expect(impact).toHaveTextContent("its new reminder time has already passed");
    expect(impact).toHaveTextContent("2 completed occurrences are never changed.");
    expect(await axeViolations(baseElement)).toEqual([]);
    await user.click(within(dialog).getByTestId("reminder-scope-confirm"));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    const sent = callsTo("PUT", `/api/v1/tasks/${TASK}/reminder`).map(([, init]) => bodyOf(init));
    expect(sent.at(-1)).toMatchObject({
      scope: "series",
      expectedSeriesRevision: 4,
      dryRun: false,
    });
  });

  it("offers to move a reminder on hold with the new due date, or remove it", async () => {
    const user = userEvent.setup();
    routes.set(`POST /api/v1/tasks/${TASK}/reminder/review`, () => ({
      status: 200,
      body: { outcome: "saved", fireAt: "2027-04-01T07:00:00+00:00", revision: 3 },
    }));
    reminder({
      reminder: {
        ...scheduled,
        status: "needs_review",
        fireAt: null,
        reviewFireAt: "2027-04-01T07:00:00+00:00",
      },
    });
    expect(screen.getByTestId("reminder-summary")).toHaveTextContent(
      "On hold until you choose what happens to it.",
    );
    expect(screen.getByText("The due date changed, so this reminder is on hold.")).toBeVisible();
    expect(screen.getByText(/comes around 01\/04\/2027 09:00/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Move with the due date" }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(bodyOf(callsTo("POST", `/api/v1/tasks/${TASK}/reminder/review`)[0]?.[1])).toEqual({
      choice: "follow",
      expectedRevision: 2,
    });
  });

  it("says when an occurrence's reminder is switched off", () => {
    reminder({
      recurring: true,
      reminder: {
        ...scheduled,
        mode: null,
        daysBefore: null,
        time: null,
        timeZone: null,
        fireAt: null,
        status: "off",
      },
    });
    expect(screen.getByTestId("task-reminder")).toHaveTextContent(
      "No reminder for this occurrence. The series' reminder does not apply to it.",
    );
  });

  it("offers no change on a completed task, or to someone who may not edit it", () => {
    reminder({ completed: true, reminder: { ...scheduled, status: "not_sent" } });
    expect(screen.queryByRole("button", { name: "Change reminder" })).toBeNull();
    expect(screen.getByText("This task is completed, so it gets no reminder.")).toBeVisible();
  });
});

function template(extra: Partial<TaskTemplate> = {}): TaskTemplate {
  return {
    id: TEMPLATE,
    homeId: HOME,
    name: "Bins",
    title: "Take out the bins",
    description: "Before 7",
    priority: "normal",
    labelIds: [LABEL],
    omittedLabels: 1,
    subtasks: ["Paper", "Glass"],
    revision: 3,
    canManage: true,
    ...extra,
  };
}

describe("TemplateLibrary", () => {
  const summary = {
    id: TEMPLATE,
    name: "Bins",
    title: "Take out the bins",
    priority: "normal" as const,
    labelCount: 1,
    subtaskCount: 2,
    revision: 3,
  };

  it("lists templates; members only use them", async () => {
    const { container } = renderWithQuery(
      <TemplateLibrary homeId={HOME} templates={[summary]} labels={labels} canManage={false} />,
    );
    expect(screen.getByTestId("template")).toHaveTextContent(
      "Task “Take out the bins”, 1 label, 2 checklist items",
    );
    expect(screen.queryByRole("button", { name: "New template" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit template Bins" })).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("creates a template with its checklist, one item per line", async () => {
    const user = userEvent.setup();
    routes.set("POST /api/v1/task-templates", () => ({ status: 201, body: { revision: 1 } }));
    renderWithQuery(<TemplateLibrary homeId={HOME} templates={[]} labels={labels} canManage />);
    await user.click(screen.getByRole("button", { name: "New template" }));
    await user.type(screen.getByLabelText(/Template name/), "Bins");
    await user.type(screen.getByLabelText(/^Title/), "Take out the bins");
    await user.type(screen.getByLabelText(/Checklist/), "Paper{Enter}{Enter}Glass");
    await user.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(bodyOf(callsTo("POST", "/api/v1/task-templates")[0]?.[1])).toMatchObject({
      homeId: HOME,
      name: "Bins",
      title: "Take out the bins",
      description: null,
      priority: null,
      labelIds: [],
      subtasks: ["Paper", "Glass"],
    });
  });

  it("asks before deleting, saying tasks made from it stay", async () => {
    const user = userEvent.setup();
    routes.set(`DELETE /api/v1/task-templates/${TEMPLATE}`, () => ({ status: 200, body: {} }));
    renderWithQuery(
      <TemplateLibrary homeId={HOME} templates={[summary]} labels={labels} canManage />,
    );
    await user.click(screen.getByRole("button", { name: "Delete template Bins" }));
    const dialog = screen.getByRole("dialog", { name: "Delete the template “Bins”?" });
    expect(dialog).toHaveTextContent("Tasks made from it stay as they are.");
    await user.click(within(dialog).getByTestId("template-delete-confirm"));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(bodyOf(callsTo("DELETE", `/api/v1/task-templates/${TEMPLATE}`)[0]?.[1])).toEqual({
      expectedRevision: 3,
    });
  });
});

describe("SaveAsTemplate", () => {
  it("prefills from the task's reusable content only", async () => {
    const user = userEvent.setup();
    const task: SaveAsTemplateProps["task"] = {
      homeId: HOME,
      title: "Fix the tap",
      description: "Kitchen",
      priority: "high",
      labels: [{ id: LABEL, name: "Plumbing", color: "blue" }],
      subtasks: [
        { id: "a", title: "Buy a washer", completed: true, revision: 1 },
        { id: "b", title: "Fit it", completed: false, revision: 1 },
      ],
    };
    routes.set("POST /api/v1/task-templates", () => ({ status: 201, body: { revision: 1 } }));
    renderWithQuery(<SaveAsTemplate task={task} labels={labels} />);
    await user.click(screen.getByRole("button", { name: "Save as template" }));
    const dialog = screen.getByRole("dialog", { name: "Save as template" });
    expect(within(dialog).getByLabelText(/Checklist/)).toHaveValue("Buy a washer\nFit it");
    await user.click(within(dialog).getByRole("button", { name: "Save template" }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(bodyOf(callsTo("POST", "/api/v1/task-templates")[0]?.[1])).toMatchObject({
      homeId: HOME,
      name: "Fix the tap",
      title: "Fix the tap",
      description: "Kitchen",
      priority: "high",
      labelIds: [LABEL],
      subtasks: ["Buy a washer", "Fit it"],
    });
  });
});

describe("FromTemplate", () => {
  const summaries = [
    {
      id: TEMPLATE,
      name: "Bins",
      title: "Take out the bins",
      priority: null,
      labelCount: 1,
      subtaskCount: 2,
      revision: 3,
    },
  ];

  it("previews an editable task, says a label was left out, and creates it in the chosen list", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    routes.set(`GET /api/v1/task-templates/${TEMPLATE}`, () => ({ status: 200, body: template() }));
    routes.set(`POST /api/v1/task-templates/${TEMPLATE}/tasks`, () => ({
      status: 201,
      body: { revision: 1 },
    }));
    const { container } = renderWithQuery(
      <FromTemplate
        templates={summaries}
        lists={[
          { id: LIST, name: "Chores" },
          { id: LIST_B, name: "Garden" },
        ]}
        defaultListId={LIST}
        labels={labels}
        onCreated={onCreated}
        onCancel={() => undefined}
      />,
    );
    const form = await screen.findByRole("form", { name: "New task from Bins" });
    expect(within(form).getByTestId("omitted-labels")).toHaveTextContent(
      "1 label of this template no longer exists and was left out.",
    );
    expect(await axeViolations(container)).toEqual([]);
    const title = within(form).getByLabelText(/^Title/);
    await user.clear(title);
    await user.type(title, "Bins out tonight");
    await user.selectOptions(within(form).getByLabelText(/^List/), LIST_B);
    await user.click(within(form).getByRole("button", { name: "Create task" }));
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalled();
    });
    expect(
      bodyOf(callsTo("POST", `/api/v1/task-templates/${TEMPLATE}/tasks`)[0]?.[1]),
    ).toMatchObject({
      expectedTemplateRevision: 3,
      listId: LIST_B,
      title: "Bins out tonight",
      description: "Before 7",
      priority: "normal",
      labelIds: [LABEL],
      subtasks: ["Paper", "Glass"],
      startDate: null,
      dueDate: null,
    });
  });

  it("reloads the preview when the template changed, and creates nothing", async () => {
    const user = userEvent.setup();
    let revision = 3;
    routes.set(`GET /api/v1/task-templates/${TEMPLATE}`, () => ({
      status: 200,
      body: template({
        revision,
        title: revision === 3 ? "Take out the bins" : "Bins and compost",
      }),
    }));
    routes.set(`POST /api/v1/task-templates/${TEMPLATE}/tasks`, () => {
      revision = 4;
      return { status: 409, body: { error: "template-changed", revision: 4 } };
    });
    renderWithQuery(
      <FromTemplate
        templates={summaries}
        lists={[{ id: LIST, name: "Chores" }]}
        defaultListId={LIST}
        labels={labels}
        onCreated={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const form = await screen.findByRole("form", { name: "New task from Bins" });
    await user.click(within(form).getByRole("button", { name: "Create task" }));
    expect(await screen.findByText(/Someone changed this template/)).toBeVisible();
    await waitFor(() => {
      expect(screen.getByLabelText(/^Title/)).toHaveValue("Bins and compost");
    });
  });
});

function row(extra: Partial<TaskRow> = {}): TaskRow {
  return {
    id: TASK,
    listId: LIST,
    listName: "Chores",
    title: "Fix the tap",
    startDate: null,
    dueDate: null,
    priority: null,
    completed: false,
    needsReassignment: false,
    overdue: false,
    upcoming: false,
    subtasksDone: 0,
    subtasksTotal: 0,
    commentCount: 0,
    labelIds: [],
    assigneeIds: [],
    assignedToMe: false,
    canComplete: true,
    revision: 2,
    recurring: false,
    ...extra,
  };
}

describe("bulk actions", () => {
  function list() {
    return renderWithQuery(
      <TaskList
        userId="user-a"
        homeId={HOME}
        initial={{
          tasks: [
            row(),
            row({ id: TASK_B, title: "Paint the door", revision: 5, recurring: true }),
          ],
          total: 2,
        }}
        query="status=open"
        loadedAt="2026-10-16T10:00:00.000Z"
        labels={labels}
        members={members}
        dateFormat="dmy-slash"
        showListName
        filtered={false}
        pageSize={50}
        moveLists={[
          { id: LIST, name: "Chores" },
          { id: LIST_B, name: "Garden" },
        ]}
      />,
    );
  }

  it("selects shown tasks, previews per task with reasons and warnings, then reports a partial result", async () => {
    const user = userEvent.setup();
    routes.set("POST /api/v1/tasks/bulk", (init) => {
      const body = bodyOf(init) as { dryRun: boolean };
      const response: BulkResponse = body.dryRun
        ? {
            action: "move",
            dryRun: true,
            results: [
              {
                taskId: TASK,
                outcome: "will_change",
                revision: 2,
                openSubtasks: 0,
                recurring: false,
                shared: false,
              },
              {
                taskId: TASK_B,
                outcome: "will_change",
                revision: 5,
                openSubtasks: 0,
                recurring: true,
                shared: false,
              },
            ],
          }
        : {
            action: "move",
            dryRun: false,
            results: [
              {
                taskId: TASK,
                outcome: "changed",
                revision: 3,
                openSubtasks: 0,
                recurring: false,
                shared: false,
              },
              {
                taskId: TASK_B,
                outcome: "conflict",
                revision: 6,
                openSubtasks: 0,
                recurring: true,
                shared: false,
              },
            ],
          };
      return { status: 200, body: response };
    });
    const { baseElement } = list();
    await user.click(screen.getByRole("button", { name: "Select tasks" }));
    const bar = screen.getByRole("region", { name: "Selected tasks" });
    await user.click(within(bar).getByRole("button", { name: "Select all shown (2)" }));
    expect(within(bar).getByTestId("bulk-count")).toHaveTextContent("2 tasks selected");
    await user.selectOptions(within(bar).getByLabelText("Action"), "move");
    await user.selectOptions(within(bar).getByLabelText("Move to"), LIST_B);
    await user.click(within(bar).getByRole("button", { name: "Review 2 tasks" }));
    const dialog = await screen.findByRole("dialog", { name: "Move to list: what would happen" });
    await waitFor(() => {
      expect(within(dialog).getByTestId("bulk-outcome")).toHaveTextContent("2 tasks will change.");
    });
    expect(within(dialog).getByTestId("bulk-warnings")).toHaveTextContent(
      "1 task repeats; only this occurrence changes, never the series.",
    );
    expect(await axeViolations(baseElement)).toEqual([]);
    await user.click(within(dialog).getByTestId("bulk-apply"));
    const result = await screen.findByRole("dialog", { name: "Result" });
    expect(within(result).getByTestId("bulk-outcome")).toHaveTextContent(
      "Partly done: 1 of 2 tasks changed.",
    );
    expect(within(result).getByTestId("bulk-excluded")).toHaveTextContent(
      "Paint the door: someone changed it since the preview",
    );
    const applied = callsTo("POST", "/api/v1/tasks/bulk").map(([, init]) => bodyOf(init));
    expect(applied.at(-1)).toEqual({
      action: "move",
      listId: LIST_B,
      homeId: HOME,
      taskIds: [TASK, TASK_B],
      expectedRevisions: { [TASK]: 2, [TASK_B]: 5 },
      dryRun: false,
    });
  });

  it("keeps add, remove and replace of labels apart", async () => {
    const user = userEvent.setup();
    list();
    await user.click(screen.getByRole("button", { name: "Select tasks" }));
    const bar = screen.getByRole("region", { name: "Selected tasks" });
    await user.click(screen.getByRole("checkbox", { name: "Select Fix the tap" }));
    await user.selectOptions(within(bar).getByLabelText("Action"), "labels");
    expect(within(bar).getByRole("radio", { name: "Add these labels" })).toBeChecked();
    expect(within(bar).getByRole("radio", { name: "Remove these labels" })).not.toBeChecked();
    expect(
      within(bar).getByRole("radio", { name: "Replace all labels with these" }),
    ).not.toBeChecked();
  });
});
