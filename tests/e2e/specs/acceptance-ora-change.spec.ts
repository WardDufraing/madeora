import type { Page } from "@playwright/test";

import { registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";

// S48, the "Ora change" journey (Project-entry.md) without free text: open Ora, pick an action,
// review the editable preview, confirm with the action-named button, see the result with Undo,
// and recover. Nothing is saved before the confirm; Undo moves an added task to the Trash and
// reopens a completed one.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
});

async function openAction(page: Page, name: string) {
  await page.getByTestId("ora-launcher").click();
  const surface = page.getByRole("dialog", { name: "Ora" });
  await expect(surface).toBeVisible();
  const button = surface.getByRole("button", { name, exact: true }).first();
  if (!(await button.isVisible())) {
    await surface.getByRole("button", { name: "Browse all actions" }).click();
  }
  await button.click();
  return surface;
}

test("Ora change: preview, edit, confirm, result and Undo for an added and a completed task", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const account = await registerConfirmed(baseURL ?? "");
  await signIn(page, account);
  // A list to add to (the guided change offers only lists the person can use).
  await page.goto("/tasks/manage");
  await page.getByTestId("list-new").fill("Errands");
  await page.getByRole("button", { name: "Create list" }).click();
  await expect(page.getByTestId("manage-list").filter({ hasText: "Errands" })).toBeVisible();
  await page.goto("/tasks");
  await expect(page.getByTestId("task-row")).toHaveCount(0);

  // 1. Ask for help: the guided "Add a task" with an editable preview that saves nothing yet.
  const surface = await openAction(page, "Add a task");
  const form = surface.getByTestId("ora-action-form");
  await expect(form).toBeVisible();
  const summary = surface.getByTestId("ora-action-summary");
  await expect(summary).toContainText("Type what you would like to add");
  await form.getByLabel("Task").fill("Book the boiler service");
  await expect(summary).toContainText("I will add the task “Book the boiler service”");
  await form.getByLabel("Task").fill("Book the boiler service today");
  await form.getByLabel("Due date (optional)").fill("2030-05-01");
  await expect(summary).toContainText("Book the boiler service today");
  await expect(summary).toContainText("with due date 2030-05-01");
  expect(await axeViolations(page)).toEqual([]);

  // Nothing is saved before the confirm: a second tab sees no task yet.
  const other = await page.context().newPage();
  await other.goto("/tasks");
  await expect(other.getByTestId("task-row")).toHaveCount(0);

  // 2. Review and edit once more, then confirm with the action-named button.
  await form.getByLabel("Task").fill("Book the boiler service");
  await surface.getByRole("button", { name: "Add task", exact: true }).click();
  const done = surface.getByTestId("ora-action-done");
  await expect(done).toContainText("Added the task “Book the boiler service”");
  await expect(done.getByRole("button", { name: "Undo" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // The change is real, with the confirmed (edited) values.
  await other.reload();
  await expect(
    other.getByTestId("task-row").filter({ hasText: "Book the boiler service" }),
  ).toBeVisible();
  await expect(other.getByText("Book the boiler service today")).toHaveCount(0);

  // 3. Recover: Undo moves the added task to the Trash, where it can still be restored.
  await done.getByRole("button", { name: "Undo" }).click();
  await expect(done).toContainText("It was moved to the Trash");
  await expect(done.getByRole("button", { name: "Undo" })).toHaveCount(0);
  await other.reload();
  await expect(other.getByTestId("task-row")).toHaveCount(0);

  // 4. A second change: add again, then complete it from Ora and take that back too.
  await done.getByRole("button", { name: "Add another" }).click();
  await form.getByLabel("Task").fill("Send the meter reading");
  await surface.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(surface.getByTestId("ora-action-done")).toContainText("Send the meter reading");
  await surface.getByRole("button", { name: "Back" }).click();

  await surface.getByRole("button", { name: "Browse all actions" }).click();
  await surface.getByRole("button", { name: "Complete a task", exact: true }).click();
  const taskForm = surface.getByTestId("ora-task-action-form");
  const optionValue = await taskForm
    .getByRole("option", { name: /Send the meter reading/ })
    .getAttribute("value");
  await taskForm.getByLabel("Task").selectOption(optionValue ?? "");
  await expect(surface.getByTestId("ora-task-action-summary")).toContainText(
    "I will mark “Send the meter reading” as done.",
  );
  await surface.getByRole("button", { name: "Complete task", exact: true }).click();
  const taskDone = surface.getByTestId("ora-task-action-done");
  await expect(taskDone).toContainText("Completed “Send the meter reading”");
  await taskDone.getByRole("button", { name: "Undo" }).click();
  await expect(taskDone).toContainText("The task is open again");

  await other.reload();
  await expect(
    other.getByTestId("task-row").filter({ hasText: "Send the meter reading" }),
  ).toBeVisible();
  await other.close();
});
