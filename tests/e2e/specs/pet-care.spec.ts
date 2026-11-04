import type { Browser, Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile } from "../support/database";

// S31 care part: "Pet care". Care is scheduled once or on a recurrence, assigned to members, and any
// member marks it done; care with medical details shows only its category to someone without
// medical access. Each test makes its own accounts.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
});

function isoDaysAhead(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

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
    timezoneId: "Europe/London",
  });
  const page = await context.newPage();
  const account = await newAdult(page, baseURL, name);
  return { page, account, close: () => context.close() };
}

/** Adds care from the pet's page and returns the new activity's page. */
async function addCare(
  page: Page,
  petUrl: string,
  care: {
    readonly title: string;
    readonly category: string;
    readonly frequency: string;
    readonly startsOn: string;
    readonly member?: string;
  },
): Promise<string> {
  await page.goto(petUrl);
  await page.getByTestId("care-new").click();
  const form = page.getByTestId("care-form");
  await form.getByTestId("care-title").fill(care.title);
  await form.getByTestId("care-category").selectOption(care.category);
  await form.getByTestId("care-frequency").selectOption(care.frequency);
  await form.getByTestId("care-starts").fill(care.startsOn);
  if (care.member) {
    await form.getByTestId("care-members").getByRole("checkbox", { name: care.member }).check();
  }
  await form.getByTestId("care-save").click();
  await expect(page).toHaveURL(/\/care\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("care-heading")).toHaveText(care.title);
  return page.url();
}

test("Pet care: schedule, assign, complete, correct, change, pause, widget and concealment", async ({
  page,
  browser,
  baseURL,
}) => {
  test.slow();
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  const bea = await otherAdult(browser, baseURL, "Bea");
  addMember(homeId, bea.account.email, "member");

  await page.goto(`/homes/${homeId}/pets`);
  await page.getByTestId("pet-new").click();
  await page.getByTestId("pet-name").fill("Miso");
  await page.getByTestId("pet-new-save").click();
  await expect(page).toHaveURL(/\/pets\/[0-9a-f-]{36}$/);
  const petUrl = page.url();

  // Recurring feeding for Bea, one-time grooming that is already overdue, and daily medication.
  const breakfast = await addCare(page, petUrl, {
    title: "Breakfast",
    category: "feeding",
    frequency: "daily",
    startsOn: isoDaysAhead(0),
    member: "Bea",
  });
  await addCare(page, petUrl, {
    title: "Nail trim",
    category: "grooming",
    frequency: "once",
    startsOn: isoDaysAhead(-1),
  });
  const pill = await addCare(page, petUrl, {
    title: "Heartworm pill",
    category: "medication",
    frequency: "daily",
    startsOn: isoDaysAhead(0),
  });

  await page.goto(petUrl);
  const list = page.getByTestId("care-list");
  await expect(list.getByTestId("care-item")).toHaveCount(3);
  await expect(list.getByTestId("care-item").filter({ hasText: "Nail trim" })).toContainText(
    "Overdue",
  );
  await expect(list.getByTestId("care-item").filter({ hasText: "Breakfast" })).toContainText("Bea");
  expect(await axeViolations(page)).toEqual([]);

  // Bea, without medical access, sees the medication only as its category, and completes Breakfast.
  await bea.page.goto(petUrl);
  const beaList = bea.page.getByTestId("care-list");
  await expect(beaList).toContainText("Medication");
  await expect(beaList).not.toContainText("Heartworm pill");
  await expect(bea.page.getByTestId("care-new")).toHaveCount(0);
  await beaList.getByRole("button", { name: "Mark Breakfast for Miso done" }).click();
  await expect(
    beaList.getByTestId("care-item").filter({ hasText: "Breakfast" }).getByTestId("care-status"),
  ).toHaveText("Upcoming");
  await bea.page.goto(pill);
  await expect(bea.page.getByTestId("care-heading")).toHaveText("Medication");
  await expect(bea.page.getByTestId("care-concealed")).toBeVisible();
  await expect(bea.page.getByText("Heartworm pill")).toHaveCount(0);
  await expect(bea.page.getByTestId("care-edit")).toHaveCount(0);

  // Ward sees who did it, and corrects the note as a pet manager.
  await page.goto(breakfast);
  const recent = page.getByTestId("care-recent");
  await expect(recent.getByTestId("care-recorded")).toContainText("Done by Bea");
  await recent.getByTestId("care-correct").click();
  await page.getByRole("dialog").getByRole("textbox", { name: /Note/u }).fill("Ate half");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(recent.getByTestId("care-recorded")).toContainText("corrected");
  await expect(recent).toContainText("Ate half");
  expect(await axeViolations(page)).toEqual([]);

  // Change only tomorrow's time, then the time from the day after on: tomorrow keeps its change.
  const open = page.getByTestId("care-open").getByTestId("care-occurrence");
  await open.nth(0).getByTestId("care-change").click();
  await page.getByRole("dialog").getByLabel("Time", { exact: true }).fill("09:00");
  await page.getByTestId("care-change-save").click();
  await expect(open.nth(0)).toContainText("Tomorrow at 09:00");
  await expect(open.nth(1)).not.toContainText(" at ");
  await open.nth(1).getByTestId("care-change").click();
  await page.getByTestId("care-scope-following").check();
  await page.getByTestId("care-change-save").click();
  const form = page.getByTestId("care-form");
  await expect(form.getByTestId("care-from")).toHaveValue(isoDaysAhead(2));
  await form.getByTestId("care-time").fill("18:00");
  await form.getByTestId("care-save").click();
  await expect(form).toHaveCount(0);
  await expect(open.nth(0)).toContainText("Tomorrow at 09:00");
  await expect(open.nth(1)).toContainText("at 18:00");

  // Pausing removes the untouched open care; the one changed by hand stays, shown as Paused and
  // without Done. Resuming schedules the rest again.
  await page.getByTestId("care-pause").click();
  await expect(page.getByTestId("care-heading").locator("..")).toContainText("Paused");
  await expect(open).toHaveCount(1);
  await expect(open.first()).toContainText("Tomorrow at 09:00");
  await expect(open.first().getByTestId("care-status")).toHaveText("Paused");
  await expect(open.first().getByTestId("care-complete")).toHaveCount(0);
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(open.nth(1)).toContainText("at 18:00");

  // The Pet care widget on the Home dashboard: Bea marks the overdue grooming done there.
  await page.goto(`/homes/${homeId}`);
  await page.getByTestId("dashboard-customize").click();
  await page
    .getByTestId("dashboard-catalogue")
    .getByRole("button", { name: "Add Pet care" })
    .click();
  await page.getByTestId("dashboard-save").click();
  await expect(page.getByTestId("dashboard-editor")).toHaveCount(0);
  await bea.page.goto(`/homes/${homeId}`);
  const widget = bea.page.getByTestId("pet-care-widget");
  await expect(widget.getByTestId("pet-care-widget-row").first()).toContainText("Nail trim");
  await expect(widget).toContainText("Medication");
  await expect(widget).not.toContainText("Heartworm pill");
  await widget.getByRole("button", { name: "Mark Nail trim for Miso done" }).click();
  await expect(widget.getByText("Nail trim")).toHaveCount(0);
  expect(await axeViolations(bea.page)).toEqual([]);

  await bea.close();
});
