import type { Page } from "@playwright/test";

import { registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile } from "../support/database";

// S29: numeric habits. A daily target is reached in steps (quick-add and manual entry), exceeded
// without carrying over, undone from the confirmation, and its target changed with a preview and a
// separate confirmation when today's status flips; decimals are typed the way the person's locale
// writes them; two members add to one Home habit, and only the manager sees who added what.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/Brussels",
  viewport: { width: 1280, height: 900 },
});

async function newAdult(page: Page, baseURL: string | undefined, name: string) {
  const account = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(account.email, name, "#2563eb");
  await signIn(page, account);
  return account;
}

/** Creates a daily habit counted in millilitres, starting today, and lands on its page. */
async function createWaterHabit(page: Page, name: string, target: string) {
  await page.getByTestId("habit-new").click();
  const form = page.getByTestId("habit-form");
  await form.getByTestId("habit-name").fill(name);
  await form.getByTestId("habit-kind-daily").check();
  await form.getByTestId("tracking-mode").selectOption("numeric");
  await form.getByTestId("tracking-unit").selectOption("ml");
  await form.getByTestId("tracking-target").fill(target);
  await form.getByTestId("habit-save").click();
  await expect(page.getByTestId("habit-detail")).toBeVisible();
}

const progress = (page: Page) =>
  page.getByTestId("habit-progress-card").getByTestId("habit-progress-text");

test("a personal numeric habit: steps to the target, excess, Undo and a target change", async ({
  page,
  baseURL,
}) => {
  await newAdult(page, baseURL, "Ward");
  await page.goto("/habits");
  await createWaterHabit(page, "Drink water", "1000");
  await expect(progress(page)).toHaveText("0 / 1,000 mL");
  await expect(page.getByTestId("habit-current-streak")).toHaveText("No current streak");

  // A quick-add, then Undo from its confirmation.
  await page.getByRole("button", { name: "Add 250 mL to Drink water" }).click();
  await expect(progress(page)).toHaveText("250 / 1,000 mL");
  await page.getByRole("button", { name: "Undo", exact: true }).last().click();
  await expect(progress(page)).toHaveText("0 / 1,000 mL");

  // Manual entry: the other locale's separator is refused with a reason, nothing is sent.
  const entry = page.getByTestId("habit-progress-quantity");
  await entry.fill("1,5");
  await expect(page.getByText("Write decimals with a point, for example 1.5.")).toBeVisible();
  await entry.fill("750");
  await expect(page.getByText("Will be saved as 750.")).toBeVisible();
  await page.getByTestId("habit-progress-submit").click();
  await expect(progress(page)).toHaveText("750 / 1,000 mL");
  await expect(page.getByTestId("habit-current-streak")).toHaveText("No current streak");

  // The last quick-add reaches the target, and goes beyond it.
  await page.getByRole("button", { name: "Add 500 mL to Drink water" }).click();
  await expect(progress(page)).toHaveText("1,250 / 1,000 mL");
  await expect(page.getByTestId("habit-progress-above")).toContainText("250 mL above the target");
  await expect(page.getByTestId("habit-current-streak")).toContainText("1 time in a row");
  await expect(page.getByText("Target reached for Drink water").first()).toBeVisible();

  // Undo of the last step takes the day back below the target and the streak with it.
  await page.getByRole("button", { name: "Undo", exact: true }).last().click();
  await expect(progress(page)).toHaveText("750 / 1,000 mL");
  await expect(page.getByTestId("habit-current-streak")).toHaveText("No current streak");
  await page.getByRole("button", { name: "Add 500 mL to Drink water" }).click();
  await expect(page.getByTestId("habit-current-streak")).toContainText("1 time in a row");
  expect(await axeViolations(page)).toEqual([]);

  // Review the day's contributions: each one is kept, undone ones are marked.
  await page.getByTestId("habit-numeric-day").first().getByTestId("habit-day-review").click();
  const rows = page.getByTestId("habit-contribution");
  await expect(rows).toHaveCount(4);
  await expect(page.locator('[data-status="undone"]')).toHaveCount(2);
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).first().click();

  // Raising the target to 2,000 today re-opens the day: the preview says so and asks for its own
  // confirmation before anything changes.
  await page.getByTestId("habit-change-tracking").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("tracking-target").fill("2000");
  await dialog.getByTestId("habit-tracking-when").selectOption("today");
  await dialog.getByTestId("habit-tracking-submit").click();
  await expect(dialog.getByTestId("habit-tracking-preview")).toContainText("1,000 mL to 2,000 mL");
  await expect(dialog.getByTestId("habit-tracking-today")).toContainText(
    "today is no longer completed",
  );
  await expect(dialog.getByTestId("habit-tracking-submit")).toBeDisabled();
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByTestId("habit-tracking-confirm-status").check();
  await dialog.getByTestId("habit-tracking-submit").click();
  await expect(page.getByTestId("habit-progress-card")).toBeVisible();
  await expect(progress(page)).toHaveText("1,250 / 2,000 mL");
  await expect(page.getByTestId("habit-current-streak")).toHaveText("No current streak");
  await expect(page.getByTestId("habit-trackings")).toContainText("2,000 mL per day");
});

test("a Home numeric habit: two members add, only the manager sees who added what", async ({
  page,
  baseURL,
  browser,
}) => {
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  await page.goto(`/homes/${homeId}/habits`);
  await createWaterHabit(page, "Plants watered", "1000");
  const habitUrl = page.url();

  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    locale: "en-GB",
    timezoneId: "Europe/Brussels",
    viewport: { width: 1280, height: 900 },
  });
  const bea = await context.newPage();
  const beaAccount = await newAdult(bea, baseURL, "Bea");
  addMember(homeId, beaAccount.email, "member");
  await bea.goto(habitUrl);
  await bea.getByRole("button", { name: "Add 500 mL to Plants watered" }).click();
  await expect(progress(bea)).toHaveText("500 / 1,000 mL");

  // Ward adds the other half: together they reach the target.
  await page.reload();
  await expect(progress(page)).toHaveText("500 / 1,000 mL");
  await page.getByRole("button", { name: "Add 500 mL to Plants watered" }).click();
  await expect(progress(page)).toHaveText("1,000 / 1,000 mL");
  await expect(page.getByTestId("habit-current-streak")).toContainText("1 time in a row");

  // The manager reviews every contribution with who added it.
  await page.getByTestId("habit-numeric-day").first().getByTestId("habit-day-review").click();
  const all = page.getByTestId("habit-contribution");
  await expect(all).toHaveCount(2);
  await expect(page.getByTestId("habit-contributions")).toContainText("Bea");
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).first().click();

  // Bea sees the day's total, but only her own contribution.
  await bea.reload();
  await expect(progress(bea)).toHaveText("1,000 / 1,000 mL");
  await bea.getByTestId("habit-numeric-day").first().getByTestId("habit-day-review").click();
  await expect(bea.getByTestId("habit-contribution")).toHaveCount(1);
  await expect(bea.getByTestId("habit-contributions")).not.toContainText("Ward");
  expect(await axeViolations(bea)).toEqual([]);
  await context.close();
});
