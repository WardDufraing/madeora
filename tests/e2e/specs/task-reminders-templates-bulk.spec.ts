import type { Page } from "@playwright/test";

import { registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { setGlobalProfile, sql } from "../support/database";
import { runJobs } from "../support/jobs";

// S19b: reminders, templates and bulk actions. A reminder is set from the server's preview and,
// once due, delivered once by the background jobs; a template is made and used for a new task with
// its checklist; bulk complete and bulk move (where one task changed since the preview and is left
// out); keyboard and axe in both themes. Time passing is simulated in the throwaway database.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
});

/** A date `days` from today in the Personal space's timezone. */
function londonDate(days: number): string {
  const day = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(day);
}

async function start(page: Page, baseURL: string | undefined): Promise<string> {
  const account = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(account.email, "Ward", "#2563eb");
  await signIn(page, account);
  await page.goto("/tasks/manage");
  for (const name of ["House", "Garden"]) {
    await page.getByTestId("list-new").fill(name);
    await page.getByRole("button", { name: "Create list" }).click();
    await expect(page.getByTestId("manage-list").filter({ hasText: name })).toBeVisible();
  }
  await page.goto("/tasks");
  return account.email;
}

async function addTask(page: Page, title: string, due?: string): Promise<void> {
  // After adding a task the form stays open for the next one.
  const opener = page.getByTestId("new-task-open");
  if (await opener.isVisible()) await opener.click();
  await page.getByLabel("Title").fill(title);
  if (due) await page.getByLabel("Due date").fill(due);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByTestId("task-row").filter({ hasText: title })).toHaveCount(1);
}

/** Makes `email`'s reminder on `title` due now, as if its time had come. */
function makeReminderDue(email: string, title: string): void {
  sql(
    `
    create temporary table due on commit drop as
      select t.id from private.tasks t join auth.users u on u.id = t.owner_user_id
      where u.email = :'email' and t.title = :'title';
    update private.task_reminders set fire_at = now() - interval '1 minute'
      where task_id in (select id from due);
    update private.job_outbox set available_at = now() - interval '1 minute'
      where job_name = 'task-reminder' and payload->>'taskId' in (select id::text from due);
    `,
    { email, title },
  );
}

test("a reminder is previewed, saved and delivered once when it is due", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const email = await start(page, baseURL);
  await addTask(page, "Renew the insurance", londonDate(7));
  await page
    .getByTestId("task-row")
    .filter({ hasText: "Renew the insurance" })
    .getByRole("link")
    .click();

  const section = page.getByRole("region", { name: "Reminder" });
  await expect(section).toContainText("No reminder.");
  await section.getByRole("button", { name: "Set a reminder" }).click();
  // The default is a day before the due date at 09:00; the exact moment comes from the server.
  await expect(page.getByLabel("Days before the due date")).toHaveValue("1");
  await expect(page.getByTestId("reminder-preview")).toContainText("It will remind around");
  expect(await axeViolations(page)).toEqual([]);
  await section.getByRole("button", { name: "Save reminder" }).click();
  await expect(page.getByTestId("reminder-summary")).toContainText("Reminds around");
  await expect(page.getByTestId("reminder-channel")).toContainText("in the app");

  // Its time comes: the jobs deliver it, and running them again does not notify twice.
  makeReminderDue(email, "Renew the insurance");
  runJobs();
  runJobs();
  await page.reload();
  await expect(page.getByTestId("reminder-summary")).toContainText("Sent around");
  await expect(page.getByTestId("notification-count")).toHaveText("1");
  await page.getByTestId("notification-bell").click();
  const notification = page.getByTestId("notification");
  await expect(notification).toHaveCount(1);
  await expect(notification).toContainText("Renew the insurance");
});

test("a changed due date puts the reminder on hold until it moves with it", async ({
  page,
  baseURL,
}) => {
  await start(page, baseURL);
  await addTask(page, "Book the boiler service", londonDate(7));
  await page
    .getByTestId("task-row")
    .filter({ hasText: "Book the boiler service" })
    .getByRole("link")
    .click();
  const section = page.getByRole("region", { name: "Reminder" });
  await section.getByRole("button", { name: "Set a reminder" }).click();
  await expect(page.getByTestId("reminder-preview")).toContainText("It will remind around");
  await section.getByRole("button", { name: "Save reminder" }).click();
  await expect(page.getByTestId("reminder-summary")).toContainText("Reminds around");

  // Moving the due date warns first, then holds the reminder (the page still loads).
  await page.getByTestId("task-edit").click();
  await page.getByLabel("Due date").fill(londonDate(10));
  await expect(
    page.getByText("This task has a reminder before its due date.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("reminder-summary")).toHaveText(
    "On hold until you choose what happens to it.",
  );
  await expect(section).toContainText("If it moves with the due date, it comes around");
  expect(await axeViolations(page)).toEqual([]);
  await section.getByRole("button", { name: "Move with the due date" }).click();
  await expect(page.getByTestId("reminder-summary")).toContainText("Reminds around");
});

test("save a task as a template, then create a task from it with its checklist", async ({
  page,
  baseURL,
}) => {
  await start(page, baseURL);
  await addTask(page, "Clean the gutters");
  await page
    .getByTestId("task-row")
    .filter({ hasText: "Clean the gutters" })
    .getByRole("link")
    .click();
  await page.getByTestId("subtask-new").fill("Fetch the ladder");
  await page.getByTestId("subtask-new").press("Enter");
  await expect(page.getByTestId("subtask")).toHaveCount(1);

  await page.getByTestId("save-as-template").click();
  const dialog = page.getByRole("dialog", { name: "Save as template" });
  await expect(dialog.getByLabel("Checklist")).toHaveValue("Fetch the ladder");
  await dialog.getByLabel("Template name").fill("Autumn gutters");
  await dialog.getByRole("button", { name: "Save template" }).click();
  await expect(dialog).toBeHidden();

  await page.goto("/tasks/templates");
  await expect(page.getByTestId("template").filter({ hasText: "Autumn gutters" })).toContainText(
    "1 checklist item",
  );

  await page.goto("/tasks");
  await page.getByTestId("new-task-from-template").click();
  await page.getByLabel("Template", { exact: true }).selectOption({ label: "Autumn gutters" });
  const form = page.getByRole("form", { name: "New task from Autumn gutters" });
  await expect(form.getByLabel("Title")).toHaveValue("Clean the gutters");
  await form.getByLabel("Title").fill("Clean the gutters again");
  expect(await axeViolations(page)).toEqual([]);
  await form.getByRole("button", { name: "Create task" }).click();
  await page
    .getByTestId("task-row")
    .filter({ hasText: "Clean the gutters again" })
    .getByRole("link")
    .click();
  await expect(page.getByTestId("subtask")).toHaveCount(1);
  await expect(page.getByTestId("subtask")).toContainText("Fetch the ladder");
});

test("bulk complete, and bulk move where a task changed since the preview", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const email = await start(page, baseURL);
  for (const title of ["Sweep the path", "Rake the leaves", "Prune the roses", "Oil the hinges"]) {
    await addTask(page, title);
  }

  // Complete two.
  await page.getByTestId("bulk-select").click();
  await page.getByRole("checkbox", { name: "Select Oil the hinges" }).check();
  await page.getByRole("checkbox", { name: "Select Sweep the path" }).check();
  const bar = page.getByTestId("bulk-bar");
  await expect(page.getByTestId("bulk-count")).toHaveText("2 tasks selected");
  await bar.getByLabel("Action").selectOption("complete");
  await page.getByTestId("bulk-review").click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("bulk-outcome")).toContainText("2 tasks will change.");
  await dialog.getByTestId("bulk-apply").click();
  await expect(dialog).toContainText("Done: 2 tasks changed.");
  await dialog.getByTestId("bulk-done").click();
  await expect(page.getByTestId("task-row").filter({ hasText: "Oil the hinges" })).toHaveCount(0);

  // Selecting stays on with an empty selection. Move the other two to Garden; one is changed
  // elsewhere after the preview and is left out.
  await expect(page.getByTestId("bulk-count")).toHaveText("No tasks selected");
  await page.getByRole("checkbox", { name: "Select Rake the leaves" }).check();
  await page.getByRole("checkbox", { name: "Select Prune the roses" }).check();
  await page.getByTestId("bulk-bar").getByLabel("Action").selectOption("move");
  await page.getByTestId("bulk-bar").getByLabel("Move to").selectOption({ label: "Garden" });
  await page.getByTestId("bulk-review").click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("bulk-outcome")).toContainText("2 tasks will change.");
  expect(await axeViolations(page)).toEqual([]);
  sql(
    `update private.tasks set title = 'Prune the roses', revision = revision + 1
     where title = 'Prune the roses'
       and owner_user_id = (select id from auth.users where email = :'email');`,
    { email },
  );
  await dialog.getByTestId("bulk-apply").click();
  await expect(dialog).toContainText("Partly done: 1 of 2 tasks changed.");
  await expect(dialog.getByTestId("bulk-excluded")).toContainText(
    "Prune the roses: someone changed it since the preview",
  );
  await dialog.getByTestId("bulk-done").click();
  await page.goto("/tasks?status=all");
  await expect(page.getByTestId("task-row").filter({ hasText: "Rake the leaves" })).toContainText(
    "Garden",
  );
  await expect(page.getByTestId("task-row").filter({ hasText: "Prune the roses" })).toContainText(
    "House",
  );
});

for (const scheme of ["light", "dark"] as const) {
  test(`bulk selection and the reminder form by keyboard in the ${scheme} theme`, async ({
    page,
    baseURL,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await start(page, baseURL);
    await addTask(page, "Feed the cat", londonDate(3));

    await page.getByTestId("bulk-select").focus();
    await page.keyboard.press("Enter");
    await page.getByRole("checkbox", { name: "Select Feed the cat" }).focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("bulk-count")).toHaveText("1 task selected");
    await page.getByTestId("bulk-review").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    // Escape closes the preview and returns focus to the review button.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("bulk-review")).toBeFocused();
    expect(await axeViolations(page)).toEqual([]);

    await page.goto("/tasks");
    await page
      .getByTestId("task-row")
      .filter({ hasText: "Feed the cat" })
      .getByRole("link")
      .focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Set a reminder" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("reminder-preview")).toContainText("It will remind around");
    expect(await axeViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "Save reminder" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("reminder-summary")).toContainText("Reminds around");
  });
}
