import type { Browser, Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile, sql } from "../support/database";

// S18: tasks core. Lists and All Tasks, creating, assigning, shared completion, subtasks, comments,
// delete to the trash and restore with a conflict, a member without rights, and keyboard use in
// both themes. Each test makes its own accounts; Homes are set up directly in the throwaway test
// database (invitations are covered elsewhere).
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
  // The browser logs the deliberate refusals (a forged completion, a stale edit).
  allowedConsoleErrors: [/status of (403|404|409)/],
});

async function newAdult(page: Page, baseURL: string | undefined, name: string): Promise<Account> {
  const account = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(account.email, name, "#2563eb");
  await signIn(page, account);
  return account;
}

async function secondAdult(
  browser: Browser,
  baseURL: string | undefined,
  name: string,
): Promise<{ page: Page; account: Account; close: () => Promise<void> }> {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    locale: "en-GB",
    timezoneId: "Europe/London",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const account = await newAdult(page, baseURL, name);
  return { page, account, close: () => context.close() };
}

async function createList(page: Page, base: string, name: string): Promise<void> {
  await page.goto(`${base}/manage`);
  await page.getByTestId("list-new").fill(name);
  await page.getByRole("button", { name: "Create list" }).click();
  await expect(page.getByTestId("manage-list").filter({ hasText: name })).toBeVisible();
}

async function addTask(
  page: Page,
  title: string,
  extra: (page: Page) => Promise<void> = async () => {},
) {
  // The form stays open after adding a task, ready for the next one.
  const open = page.getByTestId("new-task-open");
  const form = page.getByTestId("new-task-form");
  await expect(open.or(form)).toBeVisible();
  if (await open.isVisible()) await open.click();
  await page.getByLabel("Title").fill(title);
  await extra(page);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByTestId("task-row").filter({ hasText: title })).toBeVisible();
}

test("personal tasks: lists, create, labels, subtasks, comment, complete, delete and restore", async ({
  page,
  baseURL,
}) => {
  // A long journey through several pages and two browsers.
  test.slow();
  await newAdult(page, baseURL, "Ward");
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
  await expect(page.getByText("No task lists yet")).toBeVisible();

  await createList(page, "/tasks", "Errands");
  await createList(page, "/tasks", "Administration");
  // A confusing duplicate is refused.
  await page.getByTestId("list-new").fill("errands");
  await page.getByRole("button", { name: "Create list" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "That name is already used here." }),
  ).toBeVisible();
  await page.getByTestId("label-new").fill("Shop");
  await page.getByLabel("Colour").selectOption("teal");
  await page.getByRole("button", { name: "Create label" }).click();
  await expect(page.getByTestId("manage-label").filter({ hasText: "Shop" })).toBeVisible();

  await page.getByRole("link", { name: "Back to tasks" }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await addTask(page, "Buy bulbs", async (p) => {
    await p.getByLabel("Due date").fill("2026-10-10");
    await p.getByLabel("Priority").selectOption("high");
    await p.getByTestId("new-task-form").getByRole("checkbox", { name: "Shop" }).check();
  });
  const row = page.getByTestId("task-row").filter({ hasText: "Buy bulbs" });
  await expect(row).toContainText("In Errands");
  await expect(row).toContainText("Priority: High");
  await expect(row).toContainText("Shop");
  expect(await axeViolations(page)).toEqual([]);

  // Filter by label, then clear.
  await page.getByTestId("task-filters").getByRole("checkbox", { name: "Shop" }).check();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("task-row")).toHaveCount(1);
  await page.getByRole("link", { name: "Clear filters" }).click();

  await row.getByRole("link", { name: "Buy bulbs" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Buy bulbs" })).toBeVisible();
  await page.getByTestId("subtask-new").fill("Measure the socket");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByTestId("subtask")).toHaveCount(1);
  await expect(page.getByTestId("subtask-new")).toBeFocused();
  await page.getByTestId("comment-new").fill("E27, warm white.");
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.getByTestId("task-comment")).toContainText("E27, warm white.");
  await expect(page.getByTestId("task-comment")).toContainText("You");

  // Completing with an open subtask asks first; the subtask stays open.
  await page.getByTestId("task-complete").click();
  await page.getByTestId("task-confirm-complete").click();
  await expect(page.getByTestId("task-status")).toContainText("Completed by You");
  await expect(page.getByTestId("subtask-progress")).toContainText("0 of 1 subtasks done");
  await page.getByTestId("task-complete").click();
  await expect(page.getByTestId("task-status")).toContainText("Not completed");

  await page.getByTestId("task-delete").click();
  await page.getByTestId("task-confirm-delete").click();
  await expect(page.getByTestId("task-notice")).toBeFocused();
  await expect(page.getByTestId("task-row")).toHaveCount(0);
  await page.getByRole("link", { name: "Open the trash" }).click();
  const entry = page.getByTestId("trash-entry").filter({ hasText: "Buy bulbs" });
  await expect(entry).toContainText("Task");
  await entry.getByRole("checkbox").check();
  await page.getByTestId("trash-restore").click();
  await expect(page.getByTestId("trash-result")).toContainText("Restored");
  await page.goto("/tasks");
  await page.getByTestId("task-row").filter({ hasText: "Buy bulbs" }).getByRole("link").click();
  await expect(page.getByTestId("subtask")).toHaveCount(1);
  await expect(page.getByTestId("task-comment")).toHaveCount(1);
});

test("Home tasks: assign, shared completion, rights of a plain member, and privacy", async ({
  page,
  browser,
  baseURL,
}) => {
  // A long journey through several pages and two browsers.
  test.slow();
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  const bea = await secondAdult(browser, baseURL, "Bea");
  addMember(homeId, bea.account.email, "member");
  const base = `/homes/${homeId}/tasks`;

  // The sidebar's Tasks follows the open Home.
  await page.goto(`/homes/${homeId}`);
  await page
    .getByRole("navigation", { name: /main/i })
    .getByRole("link", { name: "Tasks" })
    .click();
  await expect(page).toHaveURL(new RegExp(`${base}$`));
  await createList(page, base, "Kitchen");
  await page.goto(base);
  await addTask(page, "Fix the tap", async (p) => {
    await p.getByRole("checkbox", { name: "You" }).check();
    await p.getByRole("checkbox", { name: "Bea" }).check();
  });
  await addTask(page, "Clean the oven");
  await expect(page.getByTestId("task-row").filter({ hasText: "Fix the tap" })).toContainText(
    "Assigned to You, Bea",
  );

  // Bea, a plain Member: sees both, completes the one she is assigned to, not the other.
  await bea.page.goto(base);
  await expect(bea.page.getByTestId("task-row")).toHaveCount(2);
  await expect(bea.page.getByText("Lists and labels")).toHaveCount(0);
  const oven = bea.page.getByTestId("task-row").filter({ hasText: "Clean the oven" });
  await expect(oven.getByRole("checkbox")).toHaveCount(0);
  await bea.page
    .getByTestId("task-row")
    .filter({ hasText: "Fix the tap" })
    .getByRole("checkbox", { name: "Completed: Fix the tap" })
    .check();
  await expect(bea.page.getByTestId("task-list").getByTestId("live-region")).toContainText(
    "Fix the tap",
  );

  // Ward sees one shared completion by Bea, not by every assignee.
  await page.goto(base + "?status=all");
  await page.getByTestId("task-row").filter({ hasText: "Fix the tap" }).getByRole("link").click();
  await expect(page.getByTestId("task-status")).toContainText("Completed by Bea");
  const taskUrl = page.url();

  // The member without rights: read-only, and a forged request is refused by the server.
  await bea.page.goto(base);
  await bea.page
    .getByTestId("task-row")
    .filter({ hasText: "Clean the oven" })
    .getByRole("link")
    .click();
  await expect(bea.page.getByText("You can view this task but not edit it.")).toBeVisible();
  await expect(bea.page.getByTestId("task-complete")).toHaveCount(0);
  await expect(bea.page.getByTestId("task-delete")).toHaveCount(0);
  await expect(bea.page.getByTestId("task-assignees-edit")).toHaveCount(0);
  const ovenId = bea.page.url().split("/").at(-1) ?? "";
  const forged = await bea.page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/tasks/${id}/completion`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ completed: true }),
    });
    return response.status;
  }, ovenId);
  expect(forged).toBe(403);
  // She may comment, and only she may edit her comment.
  await bea.page.getByTestId("comment-new").fill("I can do it on Saturday.");
  await bea.page.getByRole("button", { name: "Add comment" }).click();
  await expect(bea.page.getByTestId("task-comment")).toContainText("I can do it on Saturday.");
  await bea.page.goto(`${base}/manage`);
  await expect(bea.page.getByText("Not available")).toBeVisible();

  await page.goto(`${base}/${ovenId}`);
  const comment = page.getByTestId("task-comment");
  await expect(comment).toContainText("Bea");
  await expect(comment.getByRole("button", { name: "Edit" })).toHaveCount(0);

  // Ward assigns the oven task to Bea; now she may complete it.
  await page.getByTestId("task-assignees-edit").click();
  await page.getByRole("checkbox", { name: "Bea" }).check();
  await page.getByTestId("task-assignees-save").click();
  await expect(page.getByTestId("task-assignees")).toContainText("Bea");
  await bea.page.goto(`${base}/${ovenId}`);
  await expect(bea.page.getByTestId("task-complete")).toBeVisible();

  // A stranger to the Home is sent away with the neutral notice; the task id reveals nothing.
  const stranger = await secondAdult(browser, baseURL, "Cas");
  await stranger.page.goto(taskUrl);
  // The page then removes the notice from the address once shown.
  await expect(stranger.page.getByText("That Home isn't available to you.")).toBeVisible();
  const peek = await stranger.page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/tasks/${id}/completion`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ completed: false }),
    });
    return response.status;
  }, ovenId);
  expect(peek).toBe(404);
  await stranger.close();

  // Bea leaves: her open assignment ends and the task asks for reassignment.
  sql(
    `delete from public.home_memberships where home_id = :'home'::uuid
       and user_id = (select id from auth.users where email = :'email');`,
    { home: homeId, email: bea.account.email },
  );
  await page.goto(`${base}?assignee=needs_reassignment`);
  await expect(page.getByTestId("task-row").filter({ hasText: "Clean the oven" })).toContainText(
    "Needs reassignment",
  );
  await bea.close();
});

test("restore with a conflict: the task's list was deleted meanwhile", async ({
  page,
  baseURL,
}) => {
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  const base = `/homes/${homeId}/tasks`;
  await createList(page, base, "Garage");
  await createList(page, base, "Garden");
  await page.goto(base);
  await addTask(page, "Sort the screws", async (p) => {
    await p.getByTestId("new-task-form").getByLabel("List").selectOption({ label: "Garage" });
  });
  await page
    .getByTestId("task-row")
    .filter({ hasText: "Sort the screws" })
    .getByRole("link")
    .click();
  await page.getByTestId("task-delete").click();
  await page.getByTestId("task-confirm-delete").click();
  await expect(page.getByTestId("task-notice")).toBeVisible();

  // The now empty list goes to the trash too.
  await page.goto(`${base}/manage`);
  const garage = page.getByTestId("manage-list").filter({ hasText: "Garage" });
  await garage.getByTestId("manage-list-delete").click();
  await page.getByTestId("manage-list-confirm-delete").click();
  await expect(page.getByTestId("manage-list").filter({ hasText: "Garage" })).toHaveCount(0);

  await page.goto(`/homes/${homeId}/trash`);
  const entry = page.getByTestId("trash-entry").filter({ hasText: "Sort the screws" });
  await entry.getByRole("checkbox").check();
  await page.getByTestId("trash-restore").click();
  const conflict = entry.getByTestId("trash-conflict");
  await expect(conflict).toContainText("The list this task was in has been deleted or archived.");
  expect(await axeViolations(page)).toEqual([]);
  await conflict.getByLabel("Restore into list").selectOption({ label: "Garden" });
  await conflict.getByTestId("trash-move-to-list").click();
  await expect(page.getByTestId("trash-result")).toContainText("Restored");

  await page.goto(base);
  await expect(page.getByTestId("task-row").filter({ hasText: "Sort the screws" })).toContainText(
    "In Garden",
  );
});

for (const scheme of ["light", "dark"] as const) {
  test(`keyboard and accessibility in the ${scheme} theme`, async ({ page, baseURL }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await newAdult(page, baseURL, "Ward");
    await createList(page, "/tasks", "Errands");
    expect(await axeViolations(page)).toEqual([]);
    await page.goto("/tasks");

    // Open the form, type and add with the keyboard only.
    await page.getByTestId("new-task-open").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Title")).toBeFocused();
    await page.keyboard.type("Water the plants");
    await page.keyboard.press("Enter");
    const row = page.getByTestId("task-row").filter({ hasText: "Water the plants" });
    await expect(row).toBeVisible();
    await expect(page.getByLabel("Title")).toBeFocused();
    expect(await axeViolations(page)).toEqual([]);

    // Tick it with Space; focus stays on the list, which says what happened.
    await row.getByRole("checkbox").focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("task-list").getByRole("heading")).toBeFocused();
    await expect(page.getByTestId("task-list").getByTestId("live-region")).toContainText(
      "Water the plants",
    );

    await page.goto("/tasks?status=all");
    await page.getByTestId("task-row").getByRole("link").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Water the plants" })).toBeVisible();
    await page.getByTestId("subtask-new").focus();
    await page.keyboard.type("Kitchen");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("subtask")).toHaveCount(1);
    await page.getByRole("checkbox", { name: "Kitchen" }).focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("subtask-progress")).toContainText("1 of 1 subtasks done");
    expect(await axeViolations(page)).toEqual([]);

    // Escape closes the delete dialog and returns focus to its button.
    await page.getByTestId("task-delete").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("task-delete")).toBeFocused();
  });
}
