import type { Page } from "@playwright/test";

import { registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile } from "../support/database";

// S30: goals. A measurable goal gets progress twice (decimals), goes beyond its target without being
// achieved by itself, is marked achieved, appears under Completed and is reopened with its
// achievement kept; a Home's completion goal is achieved and a measurable one gets progress from the
// Goals widget by a member.
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

/** Creates a goal from the list page and lands on its page. */
async function createGoal(
  page: Page,
  title: string,
  options: { readonly kind?: "measurable" | "completion"; readonly target?: string } = {},
) {
  await page.getByTestId("goal-new").click();
  const form = page.getByTestId("goal-form");
  await form.getByTestId("goal-title").fill(title);
  if (options.kind === "completion") {
    await form.getByTestId("goal-kind").selectOption("completion");
  } else {
    await form.getByTestId("goal-unit").selectOption("km");
    await form.getByTestId("goal-target").fill(options.target ?? "10");
  }
  await form.getByTestId("goal-save").click();
  await expect(page.getByTestId("goal-detail")).toBeVisible();
}

async function addProgress(page: Page, amount: string) {
  await page.getByTestId("goal-add-progress").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("goal-add-amount").fill(amount);
  await dialog.getByTestId("goal-add-save").click();
  await expect(dialog).toHaveCount(0);
}

const progress = (page: Page) => page.getByTestId("goal-detail").getByTestId("goal-progress-text");

test("a personal measurable goal: decimals, beyond the target, achieved and reopened", async ({
  page,
  baseURL,
}) => {
  await newAdult(page, baseURL, "Ward");
  await page.goto("/goals");
  await createGoal(page, "Walk to the coast", { target: "10" });
  await expect(progress(page)).toHaveText("0 / 10 km");

  // Two contributions with decimals add up exactly; the first is undone from its confirmation.
  await addProgress(page, "2.5");
  await expect(progress(page)).toHaveText("2.5 / 10 km");
  await page.getByRole("button", { name: "Undo", exact: true }).last().click();
  await expect(progress(page)).toHaveText("0 / 10 km");
  await addProgress(page, "0.1");
  await addProgress(page, "0.2");
  await expect(progress(page)).toHaveText("0.3 / 10 km");

  // Beyond the target: the numbers stay, the bar stops at 100%, and nothing is achieved by itself.
  await addProgress(page, "10");
  await expect(progress(page)).toHaveText("10.3 / 10 km");
  await expect(page.getByTestId("goal-over-target")).toHaveText("0.3 km above the target");
  await expect(page.getByTestId("goal-target-reached")).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  await expect(page.getByTestId("goal-status")).toHaveText("Active");
  expect(await axeViolations(page)).toEqual([]);

  // Mark achieved: it moves to Completed.
  await page.getByTestId("goal-achieve").click();
  await expect(page.getByTestId("goal-status")).toHaveText("Achieved");
  await expect(page.getByTestId("goal-achievements")).toContainText("Achieved by you");
  await expect(page.getByTestId("goal-add-progress")).toHaveCount(0);
  const goalUrl = page.url();
  await page.goto("/goals?view=completed");
  await expect(page.getByTestId("goal-card")).toContainText("Walk to the coast");
  await page.goto("/goals");
  await expect(page.getByTestId("goal-card")).toHaveCount(0);

  // Reopen: active again, with the achievement kept in its history.
  await page.goto(goalUrl);
  await page.getByTestId("goal-reopen").click();
  await page.getByTestId("goal-reopen-reason").fill("One walk was counted twice");
  await page.getByTestId("goal-reopen-confirm").click();
  await expect(page.getByTestId("goal-status")).toHaveText("Active");
  await expect(page.getByTestId("goal-achievements")).toContainText("reopened by you");
  await expect(page.getByTestId("goal-achievements")).toContainText("One walk was counted twice");
  await page.getByTestId("goal-history-show").click();
  await expect(page.getByTestId("goal-events")).toContainText("Reopened by you");
  expect(await axeViolations(page)).toEqual([]);
});

test("a Home's goals: a member adds progress from the Goals widget and achieves a completion goal", async ({
  page,
  baseURL,
  browser,
}) => {
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  await page.goto(`/homes/${homeId}/goals`);
  await createGoal(page, "Save for a bike", { target: "300" });
  await page.goto(`/homes/${homeId}/goals`);
  await createGoal(page, "Paint the shed", { kind: "completion" });

  // Ward adds the Goals widget to the Home dashboard.
  await page.goto(`/homes/${homeId}`);
  await page.getByTestId("dashboard-customize").click();
  await page.getByTestId("dashboard-catalogue").getByRole("button", { name: "Add Goals" }).click();
  await page.getByTestId("dashboard-save").click();
  await expect(page.getByTestId("dashboard-editor")).toHaveCount(0);

  // Bea, a member, contributes from the widget; members contribute by default.
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    locale: "en-GB",
    timezoneId: "Europe/Brussels",
    viewport: { width: 1280, height: 900 },
  });
  const bea = await context.newPage();
  const beaAccount = await newAdult(bea, baseURL, "Bea");
  addMember(homeId, beaAccount.email, "member");
  await bea.goto(`/homes/${homeId}`);
  const widget = bea.getByTestId("goals-widget");
  await widget.getByRole("button", { name: "Add progress to Save for a bike" }).click();
  await expect(widget.getByText("Now: 0 / 300 km · Home: Thuis")).toBeVisible();
  await widget.getByTestId("goal-add-amount").fill("12.5");
  await expect(widget.getByTestId("goal-resulting-total")).toHaveText(
    "Total after this: 12.5 / 300 km",
  );
  expect(await axeViolations(bea)).toEqual([]);
  await widget.getByTestId("goal-add-save").click();
  await expect(widget.getByTestId("goal-progress-text").first()).toHaveText("12.5 / 300 km");

  // The completion goal is achieved from the widget and leaves it.
  await widget.getByRole("button", { name: "Mark Paint the shed achieved" }).click();
  await expect(widget.getByText("Paint the shed")).toHaveCount(0);

  // Ward sees who contributed, and the achieved goal under Completed.
  await page.goto(`/homes/${homeId}/goals?view=completed`);
  await expect(page.getByTestId("goal-card")).toContainText("Paint the shed");
  await page.goto(`/homes/${homeId}/goals`);
  await page.getByRole("link", { name: "Save for a bike" }).click();
  await expect(page.getByTestId("goal-entries")).toContainText("Contribution: 12.5 km by Bea");
  await context.close();
});
