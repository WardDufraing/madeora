import type { Page } from "@playwright/test";

import { registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { setGlobalProfile, sql } from "../support/database";

// S19: recurring tasks. Create a weekly task, let two weeks pass, complete this week's occurrence,
// change this and following occurrences after the preview, read the history (completed and
// missed), delete the entire series and restore it from the trash; keyboard and axe in both
// themes. Time passing is simulated by moving the series' dates back in the throwaway database.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
});

/** Today in the browser's (and so the Personal space's) timezone. */
function londonToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
}

async function start(page: Page, baseURL: string | undefined): Promise<string> {
  const account = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(account.email, "Ward", "#2563eb");
  await signIn(page, account);
  await page.goto("/tasks/manage");
  await page.getByTestId("list-new").fill("House");
  await page.getByRole("button", { name: "Create list" }).click();
  await expect(page.getByTestId("manage-list").filter({ hasText: "House" })).toBeVisible();
  await page.goto("/tasks");
  return account.email;
}

async function addWeekly(page: Page, title: string): Promise<void> {
  await page.getByTestId("new-task-open").click();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Due date").fill(londonToday());
  await page.getByTestId("repeat-frequency").selectOption("weekly");
  await expect(page.getByTestId("repeat-summary")).toContainText("Every week on");
  await expect(page.getByTestId("repeat-summary")).toContainText("Next dates:");
  await page.getByRole("button", { name: "Add task" }).click();
  // Creating it makes today's occurrence and the next one.
  const rows = page.getByTestId("task-row").filter({ hasText: title });
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Repeats");
}

/** Moves a person's series `days` into the past, as if that time had passed. */
function shiftBack(email: string, title: string, days: number): void {
  sql(
    `
    create temporary table chain on commit drop as
      select s.root_id from private.task_series s
      join auth.users u on u.id = s.owner_user_id
      where u.email = :'email' and s.title = :'title';
    update private.task_series set starts_on = starts_on - :days, next_date = next_date - :days,
      last_date = last_date - :days where root_id in (select root_id from chain);
    update private.tasks set occurrence_date = occurrence_date - :days - 100000,
      due_date = due_date - :days where series_root_id in (select root_id from chain);
    update private.tasks set occurrence_date = occurrence_date + 100000
      where series_root_id in (select root_id from chain);
    `,
    { email, title, days: String(days) },
  );
}

test("weekly task: complete, change following, history, delete the series and restore it", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const email = await start(page, baseURL);
  await addWeekly(page, "Water the plants");

  // Two weeks pass: opening the page creates the missed weeks' occurrences and the next one.
  shiftBack(email, "Water the plants", 14);
  await page.goto("/tasks?status=all");
  const rows = page.getByTestId("task-row").filter({ hasText: "Water the plants" });
  await expect(rows).toHaveCount(4);

  // Open this week's occurrence (due today) and complete it.
  await rows.filter({ hasNotText: "Overdue" }).first().getByRole("link").click();
  await expect(page.getByTestId("series-summary")).toContainText("Every week on");
  await page.getByTestId("task-complete").click();
  await expect(page.getByTestId("task-status")).toContainText("Completed by You");

  // The history: this one completed, the two earlier weeks missed.
  const history = page.getByTestId("series-history");
  await expect(history).toContainText("3 occurrences");
  await expect(
    history.getByRole("listitem").filter({ hasText: "(this occurrence)" }),
  ).toContainText("Completed by You");
  await expect(history.getByRole("listitem").filter({ hasText: "Missed" })).toHaveCount(2);
  await page.getByTestId("history-filter").selectOption("missed");
  await expect(history.getByRole("listitem")).toHaveCount(2);
  expect(await axeViolations(page)).toEqual([]);

  // From next week's occurrence, change it and the following ones, after the preview.
  await page.goto("/tasks");
  await page
    .getByTestId("task-row")
    .filter({ hasText: "Water the plants" })
    .filter({ hasNotText: "Overdue" })
    .getByRole("link")
    .click();
  await page.getByTestId("task-edit").click();
  await page.getByLabel("Title").fill("Water all the plants");
  await page.getByRole("button", { name: "Save" }).click();
  const dialog = page.getByRole("dialog", { name: "Save changes to which occurrences?" });
  await dialog.getByRole("radio", { name: "This and following occurrences" }).check();
  const impact = dialog.getByTestId("series-impact");
  await expect(impact).toContainText("1 open occurrence changes.");
  await expect(impact).toContainText("No completed occurrences are affected.");
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByTestId("series-scope-confirm").click();
  await expect(page.getByRole("heading", { level: 1, name: "Water all the plants" })).toBeVisible();
  await page.goto("/tasks?status=all");
  await expect(
    page.getByTestId("task-row").filter({ hasText: "Water all the plants" }),
  ).toHaveCount(1);
  // This week's and the earlier, missed weeks keep their title.
  await expect(page.getByTestId("task-row").filter({ hasText: "Water the plants" })).toHaveCount(3);

  // Delete the entire series: the open occurrences go to the trash as one item.
  await page
    .getByTestId("task-row")
    .filter({ hasText: "Overdue" })
    .first()
    .getByRole("link")
    .click();
  await page.getByTestId("task-delete").click();
  const remove = page.getByRole("dialog", { name: "Delete which occurrences?" });
  await remove.getByRole("radio", { name: "All occurrences" }).check();
  await expect(remove.getByTestId("series-impact")).toContainText(
    "3 open occurrences go to the trash as one item",
  );
  await remove.getByTestId("series-scope-confirm").click();
  await expect(page.getByTestId("task-notice")).toBeVisible();
  await page.goto("/tasks?status=all");
  await expect(page.getByTestId("task-row")).toHaveCount(1);
  await expect(page.getByTestId("task-row")).toContainText("Completed");

  await page.goto("/settings/trash");
  const entry = page.getByTestId("trash-entry").filter({ hasText: "Repeating task occurrences" });
  await entry.getByRole("checkbox").check();
  await page.getByTestId("trash-restore").click();
  await expect(page.getByTestId("trash-result")).toContainText("Restored");
  await page.goto("/tasks?status=all");
  await expect(page.getByTestId("task-row")).toHaveCount(4);
});

for (const scheme of ["light", "dark"] as const) {
  test(`repeat fields, scope dialog and pause by keyboard in the ${scheme} theme`, async ({
    page,
    baseURL,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await start(page, baseURL);
    await page.getByTestId("new-task-open").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Title")).toBeFocused();
    await page.keyboard.type("Take out the bins");
    await page.getByLabel("Due date").fill(londonToday());
    await page.getByTestId("repeat-frequency").focus();
    await page.getByTestId("repeat-frequency").selectOption("daily");
    await expect(page.getByTestId("repeat-summary")).toContainText("Every day");
    expect(await axeViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "Add task" }).press("Enter");
    const row = page.getByTestId("task-row").filter({ hasText: "Take out the bins" }).first();
    await expect(row).toContainText("Repeats");
    await row.getByRole("link").focus();
    await page.keyboard.press("Enter");

    // Pause keeps focus on the state it changed.
    await page.getByTestId("series-pause").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("series-state")).toBeFocused();
    await expect(page.getByTestId("series-state")).toContainText("Paused.");
    await expect(page.getByTestId("series-pause")).toHaveText("Resume");
    expect(await axeViolations(page)).toEqual([]);

    // Escape closes the scope dialog and returns focus to the delete button.
    await page.getByTestId("task-delete").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("task-delete")).toBeFocused();
  });
}
