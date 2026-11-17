import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { useState } from "react";

import { ToastProvider } from "@/components/ui/toast";
import en from "@/i18n/messages/en.json";
import { ApplyError } from "@/ora/actions/client";
import type * as clientModule from "@/ora/actions/client";
import type { ActionDraft } from "@/ora/actions/draft";
import type { OraTaskEditActionId, TaskChoice, TaskEdit } from "@/ora/actions/types";
import { axeViolations } from "@/test/axe";

import { OraTaskAction } from "./ora-task-action";

const api = vi.hoisted(() => ({
  fetchTaskChoices: vi.fn(),
  fetchTaskEdit: vi.fn(),
  applyCompleteTask: vi.fn(),
  applyChangeDue: vi.fn(),
  undoCompletion: vi.fn(),
  undoDue: vi.fn(),
  recordHistory: vi.fn(),
}));
vi.mock("@/ora/actions/client", async (importOriginal) => ({
  ...(await importOriginal<typeof clientModule>()),
  fetchTaskChoices: api.fetchTaskChoices,
  fetchTaskEdit: api.fetchTaskEdit,
  applyCompleteTask: api.applyCompleteTask,
  applyChangeDue: api.applyChangeDue,
  undoCompletion: api.undoCompletion,
  undoDue: api.undoDue,
}));
vi.mock("@/ora/history/client", () => ({ recordHistory: api.recordHistory }));

const ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00aa";
const choices: TaskChoice[] = [
  { id: ID, title: "Pay rent", listName: "Inbox", dueDate: "2026-12-01" },
  {
    id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00ab",
    title: "Call mum",
    listName: "Inbox",
    dueDate: null,
  },
];
const edit: TaskEdit = {
  id: ID,
  title: "Pay rent",
  description: "Monthly",
  startDate: "2026-11-20",
  dueDate: "2026-12-01",
  priority: "high",
  labelIds: ["l1"],
  revision: 4,
  listName: "Inbox",
};

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.fetchTaskChoices.mockResolvedValue(choices);
  api.fetchTaskEdit.mockResolvedValue(edit);
  api.recordHistory.mockResolvedValue(undefined);
});

describe("Ora: guided task edits (S47d)", () => {
  // The panel holds the draft; a minimal host does the same here.
  function Host({ action }: { readonly action: OraTaskEditActionId }) {
    const [draft, setDraft] = useState<ActionDraft | undefined>(undefined);
    return (
      <OraTaskAction
        action={action}
        userId="user-a"
        homeId={null}
        contextName="Personal"
        active
        draft={draft}
        onDraft={setDraft}
        onBack={vi.fn()}
        onNavigated={vi.fn()}
        onStatus={vi.fn()}
      />
    );
  }
  function mount(action: OraTaskEditActionId) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        <QueryClientProvider client={client}>
          <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss">
            <Host action={action} />
          </ToastProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
  }

  it("needs a chosen task first and has no accessibility violations", async () => {
    const { container } = mount("complete-task");
    const form = await screen.findByTestId("ora-task-action-form");
    expect(within(form).getByRole("button", { name: "Complete task" })).toBeDisabled();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("completes the chosen task after confirmation and offers Undo that reopens only that completion", async () => {
    const user = userEvent.setup();
    api.applyCompleteTask.mockResolvedValue({
      id: ID,
      completedAt: "2026-11-15T10:00:00.123456+00:00",
    });
    api.undoCompletion.mockResolvedValue("undone");
    mount("complete-task");
    const form = await screen.findByTestId("ora-task-action-form");
    await user.selectOptions(within(form).getByLabelText("Task"), ID);
    expect(within(form).getByTestId("ora-task-action-summary")).toHaveTextContent(
      "I will mark “Pay rent” as done.",
    );
    expect(api.applyCompleteTask).not.toHaveBeenCalled();
    await user.click(within(form).getByRole("button", { name: "Complete task" }));
    const done = await screen.findByTestId("ora-task-action-done");
    expect(done).toHaveTextContent("Completed “Pay rent”.");
    expect(api.applyCompleteTask).toHaveBeenCalledWith(ID);
    expect(api.recordHistory).toHaveBeenCalledWith({
      homeId: null,
      kind: "task-completed",
      label: "Pay rent",
    });
    await user.click(within(done).getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Done. The task is open again.")).toBeInTheDocument();
    expect(api.undoCompletion).toHaveBeenCalledWith(null, {
      kind: "completion",
      id: ID,
      completedAt: "2026-11-15T10:00:00.123456+00:00",
    });
  });

  it("offers no Undo when someone else had already completed it", async () => {
    const user = userEvent.setup();
    api.applyCompleteTask.mockResolvedValue({ id: ID, completedAt: null });
    mount("complete-task");
    const form = await screen.findByTestId("ora-task-action-form");
    await user.selectOptions(within(form).getByLabelText("Task"), ID);
    await user.click(within(form).getByRole("button", { name: "Complete task" }));
    const done = await screen.findByTestId("ora-task-action-done");
    expect(done).toHaveTextContent("was already completed by someone else");
    expect(within(done).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(api.recordHistory).not.toHaveBeenCalled();
  });

  it("keeps the choice and says so when the task is no longer permitted", async () => {
    const user = userEvent.setup();
    api.applyCompleteTask.mockRejectedValue(new ApplyError("not-permitted"));
    mount("complete-task");
    const form = await screen.findByTestId("ora-task-action-form");
    await user.selectOptions(within(form).getByLabelText("Task"), ID);
    await user.click(within(form).getByRole("button", { name: "Complete task" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Nothing was changed");
    expect(within(form).getByLabelText("Task")).toHaveValue(ID);
  });

  it("changes only the due date, saving the task as it is, and Undo restores the old date", async () => {
    const user = userEvent.setup();
    api.applyChangeDue.mockResolvedValue({ id: ID, previousDue: "2026-12-01", revision: 5 });
    api.undoDue.mockResolvedValue("undone");
    mount("change-task-due");
    const form = await screen.findByTestId("ora-task-action-form");
    await user.selectOptions(within(form).getByLabelText("Task"), ID);
    const date = await within(form).findByLabelText("New due date");
    await user.type(date, "2026-12-15");
    expect(within(form).getByTestId("ora-task-action-summary")).toHaveTextContent(
      "I will set the due date of “Pay rent” to 2026-12-15 (it is 2026-12-01 now).",
    );
    expect(api.applyChangeDue).not.toHaveBeenCalled();
    await user.click(within(form).getByRole("button", { name: "Change due date" }));
    const done = await screen.findByTestId("ora-task-action-done");
    expect(done).toHaveTextContent("Changed the due date of “Pay rent”.");
    expect(api.applyChangeDue).toHaveBeenCalledWith(edit, "2026-12-15");
    await user.click(within(done).getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Done. The old due date is back.")).toBeInTheDocument();
    expect(api.undoDue).toHaveBeenCalledWith(null, {
      kind: "due",
      id: ID,
      previousDue: "2026-12-01",
      revision: 5,
    });
  });

  it("can remove the due date, and refuses a date before the start date", async () => {
    const user = userEvent.setup();
    api.applyChangeDue.mockResolvedValue({ id: ID, previousDue: "2026-12-01", revision: 5 });
    mount("change-task-due");
    const form = await screen.findByTestId("ora-task-action-form");
    await user.selectOptions(within(form).getByLabelText("Task"), ID);
    const date = await within(form).findByLabelText("New due date");
    await user.type(date, "2026-11-01");
    await user.click(within(form).getByRole("button", { name: "Change due date" }));
    expect(
      await within(form).findByText(/cannot be before the start date, 2026-11-20/),
    ).toBeInTheDocument();
    expect(api.applyChangeDue).not.toHaveBeenCalled();
    await user.click(within(form).getByRole("checkbox", { name: "Remove the due date instead" }));
    expect(within(form).getByTestId("ora-task-action-summary")).toHaveTextContent(
      "I will remove the due date of “Pay rent”.",
    );
    await user.click(within(form).getByRole("button", { name: "Change due date" }));
    await screen.findByTestId("ora-task-action-done");
    expect(api.applyChangeDue).toHaveBeenCalledWith(edit, null);
  });

  it("reloads and explains when someone changed the task while it was being edited", async () => {
    const user = userEvent.setup();
    api.applyChangeDue.mockRejectedValue(new ApplyError("conflict"));
    mount("change-task-due");
    const form = await screen.findByTestId("ora-task-action-form");
    await user.selectOptions(within(form).getByLabelText("Task"), ID);
    await user.type(await within(form).findByLabelText("New due date"), "2026-12-15");
    api.fetchTaskEdit.mockClear();
    await user.click(within(form).getByRole("button", { name: "Change due date" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Someone changed this task");
    await waitFor(() => {
      expect(api.fetchTaskEdit).toHaveBeenCalled();
    });
  });

  it("says when the task can no longer be edited, and offers no confirm", async () => {
    const user = userEvent.setup();
    api.fetchTaskEdit.mockResolvedValue(null);
    mount("change-task-due");
    const form = await screen.findByTestId("ora-task-action-form");
    await user.selectOptions(within(form).getByLabelText("Task"), ID);
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "can no longer change it here",
    );
    expect(within(form).getByRole("button", { name: "Change due date" })).toBeDisabled();
  });

  it("says when there is nothing to pick, and when the list cannot be read", async () => {
    api.fetchTaskChoices.mockResolvedValue([]);
    const first = mount("complete-task");
    expect(await screen.findByTestId("ora-task-action-nothing")).toHaveTextContent(
      "no open tasks here",
    );
    first.unmount();
    api.fetchTaskChoices.mockRejectedValue(new Error("down"));
    mount("complete-task");
    expect(await screen.findByTestId("ora-task-action-unavailable")).toHaveTextContent(
      "Nothing was changed",
    );
  });
});
