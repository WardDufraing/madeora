import type { Browser, Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, removeMember, setGlobalProfile } from "../support/database";

// S21: a member proposes a chore and a chore manager approves it; a chore that needs reassignment
// gets a volunteer. Then the overview: the Chores calendar with moving by button and by drag, a
// personal reminder, the manager's daily summary and the Chore schedule widget with its remembered
// layout. Keyboard and axe on the new screens.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/Brussels",
  viewport: { width: 1280, height: 900 },
});

async function newAdult(page: Page, baseURL: string | undefined, name: string): Promise<Account> {
  const account = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(account.email, name, "#2563eb");
  await signIn(page, account);
  return account;
}

async function otherAdult(
  browser: Browser,
  baseURL: string | undefined,
  name: string,
): Promise<{ page: Page; account: Account; close: () => Promise<void> }> {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    locale: "en-GB",
    timezoneId: "Europe/Brussels",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const account = await newAdult(page, baseURL, name);
  return { page, account, close: () => context.close() };
}

/** A one-off chore due today (or `due`), for the named member or, without one, unassigned. */
async function addChore(page: Page, title: string, member?: string, due?: string): Promise<void> {
  await page.getByTestId("new-chore-open").click();
  await page.getByLabel("Title").fill(title);
  if (due) await page.getByLabel("Due date").fill(due);
  if (member) {
    await page.getByRole("radio", { name: "Fixed members" }).check();
    await page.getByRole("checkbox", { name: member }).check();
  }
  await page.getByTestId("chore-submit").click();
  await expect(page.getByTestId("new-chore-view")).toBeVisible();
}

const shift = (date: string, days: number) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

test("proposals and volunteers", async ({ page, browser, baseURL }) => {
  test.slow();
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  const bea = await otherAdult(browser, baseURL, "Bea");
  const cal = await otherAdult(browser, baseURL, "Cal");
  addMember(homeId, bea.account.email, "member");
  addMember(homeId, cal.account.email, "member");
  const base = `/homes/${homeId}/chores`;

  // Bea, a member, proposes a chore; it waits for a chore manager.
  await bea.page.goto(base);
  await bea.page.getByTestId("chores-proposals-link").click();
  await bea.page.getByTestId("propose-open").click();
  await bea.page.getByLabel("Title").fill("Clean the windows");
  await bea.page.getByTestId("propose-form-submit").click();
  await expect(bea.page.getByText("Proposal sent for review.").first()).toBeAttached();
  await expect(bea.page.getByTestId("chore-proposals-waiting")).toContainText("Clean the windows");
  expect(await axeViolations(bea.page)).toEqual([]);

  // Ward reviews it, sees the final values and approves: it becomes a chore.
  await page.goto(`${base}/proposals`);
  const waiting = page.getByTestId("chore-proposal").filter({ hasText: "Clean the windows" });
  await waiting.getByTestId("proposal-review-open").click();
  await page.getByTestId("proposal-revise-form-submit").click();
  const approve = page.getByRole("dialog", { name: "Approve this proposal?" });
  await expect(approve.getByTestId("proposal-final")).toContainText("Clean the windows");
  await approve.getByTestId("proposal-approve-confirm").click();
  await expect(page.getByTestId("chore-proposals-decided")).toContainText("Approved");
  await page.goto(base);
  await expect(page.getByText("Clean the windows").first()).toBeVisible();

  // A chore for Cal needs reassignment once Cal leaves; Ward asks Bea to volunteer.
  await addChore(page, "Feed the cat", "Cal");
  removeMember(homeId, cal.account.email);
  await cal.close();
  await page.goto(base);
  await page
    .getByTestId("chores-group-reassign")
    .getByRole("link", { name: "Feed the cat" })
    .click();
  await page.getByTestId("volunteer-request-open").click();
  const ask = page.getByRole("dialog", { name: "Ask for a volunteer" });
  await ask.getByRole("checkbox", { name: "Bea" }).check();
  await ask.getByTestId("volunteer-request-preview").click();
  await expect(ask.getByTestId("volunteer-request-deadline")).toBeVisible();
  await ask.getByTestId("volunteer-request-send").click();
  await expect(page.getByTestId("chore-awaiting-volunteer")).toBeVisible();

  // Bea volunteers from her overview; the chore is hers.
  await bea.page.goto(base);
  const offer = bea.page.getByTestId("volunteer-offer").filter({ hasText: "Feed the cat" });
  await offer.getByTestId("volunteer-accept").click();
  await expect(bea.page.getByTestId("volunteer-offer")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("chore-awaiting-volunteer")).toHaveCount(0);
  await bea.close();
});

const widget = (page: Page, name: string) =>
  page.getByTestId("dashboard-widget").filter({ has: page.getByRole("heading", { name }) });

test("the Chores calendar, moving, reminders, the daily summary and the schedule widget", async ({
  page,
  browser,
  baseURL,
}) => {
  test.slow();
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  const bea = await otherAdult(browser, baseURL, "Bea");
  addMember(homeId, bea.account.email, "member");
  const base = `/homes/${homeId}/chores`;

  await page.goto(base);
  await addChore(page, "Dishes", "Bea");
  await page.goto(base);
  await addChore(page, "Water the plants");

  // The calendar shows the week with today's chores in the day panel, states in words.
  await page.goto(base);
  await page.getByTestId("chores-calendar-link").click();
  await expect(page.getByTestId("chore-calendar")).toContainText("Dishes");
  const panel = page.getByTestId("chore-calendar-panel");
  await expect(panel).toContainText("Water the plants");
  expect(await axeViolations(page)).toEqual([]);

  // Move Dishes to another day of this week with the keyboard: preview, then confirm.
  const day = (date: string) =>
    page.locator(`[data-testid="chore-calendar-day"][data-date="${date}"]`);
  const dishes = panel.getByTestId("chore-calendar-panel-item").filter({ hasText: "Dishes" });
  await dishes.getByTestId("chore-calendar-move").focus();
  await page.keyboard.press("Enter");
  const move = page.getByRole("dialog", { name: "Move Dishes" });
  const today = await move.getByTestId("chore-move-date").inputValue();
  // Tomorrow, unless today ends the week: then the day before.
  const target = (await day(shift(today, 1)).count()) > 0 ? shift(today, 1) : shift(today, -1);
  await move.getByTestId("chore-move-date").fill(target);
  await move.getByTestId("chore-move-preview").click();
  await expect(move.getByTestId("chore-move-summary")).toContainText(/Date: .+ → .+/);
  expect(await axeViolations(page)).toEqual([]);
  await move.getByTestId("chore-move-confirm").click();
  await expect(move).toHaveCount(0);
  await expect(day(target)).toContainText("Dishes");

  // Drag it back onto today: the Move dialog opens on that day.
  await day(target)
    .getByRole("link", { name: /Dishes/ })
    .dragTo(day(today));
  await expect(move.getByTestId("chore-move-date")).toHaveValue(today);
  await move.getByRole("button", { name: "Cancel" }).click();
  await expect(move).toHaveCount(0);

  // Bea sees the calendar but cannot move; she sets her own reminder on a chore due next week.
  await page.goto(base);
  await addChore(page, "Hoover", "Bea", shift(today, 7));
  await bea.page.goto(`${base}/calendar`);
  await expect(bea.page.getByTestId("chore-calendar")).toContainText("Dishes");
  await expect(bea.page.getByTestId("chore-calendar-move")).toHaveCount(0);
  await bea.page.goto(base);
  await bea.page.getByRole("link", { name: "Hoover" }).first().click();
  await bea.page.getByTestId("chore-reminder-edit").click();
  await bea.page.getByTestId("chore-reminder-preview-button").click();
  await expect(bea.page.getByTestId("chore-reminder-preview")).toContainText("Reminds you");
  expect(await axeViolations(bea.page)).toEqual([]);
  await bea.page.getByTestId("chore-reminder-save").click();
  await expect(bea.page.getByTestId("chore-reminder-current")).toContainText("1 day before");

  // The daily summary is for chore managers; Ward turns its notification on.
  await bea.page.goto(`${base}/summary`);
  await expect(bea.page.getByTestId("chore-summary-not-manager")).toBeVisible();
  await page.goto(base);
  await page.getByTestId("chores-summary-link").click();
  await expect(page.getByRole("heading", { name: "Daily summary", level: 1 })).toBeVisible();
  await page.getByLabel("Send me this summary once a day").check();
  await page.getByTestId("chore-summary-hour").selectOption("7");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByTestId("chore-summary-save").click();
  await expect(page.getByText("Daily summary setting saved.").first()).toBeAttached();
  await page.reload();
  await expect(page.getByLabel("Send me this summary once a day")).toBeChecked();
  await expect(page.getByTestId("chore-summary-hour")).toHaveValue("7");

  // The Home dashboard gets the Chore schedule widget: Bea's chore in the matrix, the unassigned
  // one to claim; the layout Ward picks is remembered in his browser.
  await page.goto(`/homes/${homeId}`);
  await page.getByTestId("dashboard-customize").click();
  await page
    .getByTestId("dashboard-catalogue")
    .getByRole("button", { name: "Add Chore schedule" })
    .click();
  await page.getByTestId("dashboard-save").click();
  await expect(page.getByTestId("dashboard-editor")).toHaveCount(0);
  const schedule = widget(page, "Chore schedule");
  await expect(schedule.getByTestId("chore-schedule-matrix-table")).toContainText("Bea");
  await expect(schedule.getByTestId("chore-schedule-unassigned")).toContainText("Water the plants");
  await expect(
    schedule.getByTestId("chore-schedule-unassigned").getByTestId("chore-claim"),
  ).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await schedule.getByTestId("chore-schedule-cards").click();
  await expect(schedule.getByTestId("chore-schedule-card")).toHaveCount(7);
  await page.reload();
  await expect(widget(page, "Chore schedule").getByTestId("chore-schedule-card")).toHaveCount(7);
  await widget(page, "Chore schedule").getByTestId("chore-schedule-day").click();
  await expect(widget(page, "Chore schedule").getByTestId("chore-schedule-card")).toHaveCount(1);
  await widget(page, "Chore schedule").getByTestId("chore-schedule-next").click();
  await expect(widget(page, "Chore schedule").getByTestId("chore-schedule-title")).toContainText(
    /\d/,
  );
  await bea.close();
});
