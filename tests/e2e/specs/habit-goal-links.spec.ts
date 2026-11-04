import type { Page } from "@playwright/test";

import { registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { setGlobalProfile } from "../support/database";

// S30c: habit to goal. A numeric km habit is linked to a measurable km goal with a preview; the goal
// shows the manual and linked parts; a correction on the habit (an Undo) recalculates the goal; the
// habit page lists the goal it counts toward; unlinking keeps the amount as manual progress.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/Brussels",
  viewport: { width: 1280, height: 900 },
});

const goalProgress = (page: Page) =>
  page.getByTestId("goal-detail").getByTestId("goal-progress-text");
const habitProgress = (page: Page) =>
  page.getByTestId("habit-progress-card").getByTestId("habit-progress-text");

async function addToHabit(page: Page, quantity: string) {
  await page.getByTestId("habit-progress-quantity").fill(quantity);
  await page.getByTestId("habit-progress-submit").click();
}

test("habit to goal: link with a preview, a correction recalculates, unlink keeps the amount", async ({
  page,
  baseURL,
}) => {
  // The longest goal journey: two pages, three dialogs and four axe runs.
  test.slow();
  const account = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(account.email, "Ward", "#2563eb");
  await signIn(page, account);

  // A daily running habit counted in km, with 3 km today.
  await page.goto("/habits");
  await page.getByTestId("habit-new").click();
  const habitForm = page.getByTestId("habit-form");
  await habitForm.getByTestId("habit-name").fill("Run");
  await habitForm.getByTestId("habit-kind-daily").check();
  await habitForm.getByTestId("tracking-mode").selectOption("numeric");
  await habitForm.getByTestId("tracking-unit").selectOption("km");
  await habitForm.getByTestId("tracking-target").fill("5");
  await habitForm.getByTestId("habit-save").click();
  await expect(page.getByTestId("habit-detail")).toBeVisible();
  await addToHabit(page, "3");
  await expect(habitProgress(page)).toHaveText("3 / 5 km");
  const habitUrl = page.url();

  // A measurable goal in the same unit.
  await page.goto("/goals");
  await page.getByTestId("goal-new").click();
  const goalForm = page.getByTestId("goal-form");
  await goalForm.getByTestId("goal-title").fill("Run 100 km");
  await goalForm.getByTestId("goal-unit").selectOption("km");
  await goalForm.getByTestId("goal-target").fill("100");
  await goalForm.getByTestId("goal-save").click();
  await expect(page.getByTestId("goal-detail")).toBeVisible();
  await expect(goalProgress(page)).toHaveText("0 / 100 km");
  const goalUrl = page.url();

  // Link the habit from its beginning: the preview shows the new total before anything changes.
  await page.getByTestId("goal-link-habit-open").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("goal-link-habit")).toHaveValue(/.+/);
  await dialog.getByTestId("goal-link-start").selectOption("beginning");
  await dialog.getByRole("button", { name: "Preview" }).click();
  await expect(dialog.getByTestId("goal-link-impact")).toContainText("3 km");
  await expect(goalProgress(page)).toHaveText("0 / 100 km");
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByTestId("goal-link-save").click();
  await expect(dialog).toHaveCount(0);
  await expect(goalProgress(page)).toHaveText("3 / 100 km");
  await expect(page.getByTestId("goal-link-amount")).toHaveText("adds 3 km");

  // Manual progress adds to the linked part; the goal shows both.
  await page.getByTestId("goal-add-progress").click();
  const add = page.getByRole("dialog");
  await add.getByTestId("goal-add-amount").fill("1.5");
  await add.getByTestId("goal-add-save").click();
  await expect(add).toHaveCount(0);
  await expect(goalProgress(page)).toHaveText("4.5 / 100 km");
  await expect(page.getByTestId("goal-progress-breakdown")).toHaveText(
    "Manual: 1.5 km · From linked habits: 3 km",
  );
  await expect(page).toHaveTitle(/Run 100 km/);
  expect(await axeViolations(page)).toEqual([]);

  // More running, then a correction (Undo) on the habit: the goal follows both.
  await page.goto(habitUrl);
  await expect(page.getByTestId("habit-linked-goals")).toContainText("Run 100 km");
  await addToHabit(page, "2");
  await expect(habitProgress(page)).toHaveText("5 / 5 km");
  await page.goto(goalUrl);
  await expect(goalProgress(page)).toHaveText("6.5 / 100 km");
  await page.goto(habitUrl);
  await page.getByTestId("habit-numeric-day").first().getByTestId("habit-day-review").click();
  const review = page.getByRole("dialog");
  await review
    .getByTestId("habit-contribution")
    .filter({ hasText: "2 km" })
    .getByTestId("habit-contribution-undo")
    .click();
  await expect(review.locator('[data-status="undone"]')).toHaveCount(1);
  await review.getByRole("button", { name: "Close" }).first().click();
  await expect(habitProgress(page)).toHaveText("3 / 5 km");
  await page.goto(goalUrl);
  await expect(goalProgress(page)).toHaveText("4.5 / 100 km");
  await expect(page.getByTestId("goal-progress-breakdown")).toHaveText(
    "Manual: 1.5 km · From linked habits: 3 km",
  );

  // Unlink keeping the amount: the total stays, now all manual, and the history says where it came from.
  await page.getByTestId("goal-link-unlink").click();
  const unlink = page.getByRole("dialog");
  await expect(unlink.getByTestId("goal-unlink-mode")).toHaveValue("keep");
  await unlink.getByRole("button", { name: "Preview" }).click();
  await expect(unlink.getByTestId("goal-link-impact")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await unlink.getByTestId("goal-unlink-save").click();
  await expect(unlink).toHaveCount(0);
  await expect(goalProgress(page)).toHaveText("4.5 / 100 km");
  await expect(page.getByTestId("goal-link")).toHaveCount(0);
  await expect(page.getByTestId("goal-progress-breakdown")).toHaveCount(0);

  // The habit no longer counts toward the goal, and its own progress is untouched.
  await page.goto(habitUrl);
  await expect(habitProgress(page)).toHaveText("3 / 5 km");
  await expect(page.getByTestId("habit-linked-goals")).toHaveCount(0);
});
