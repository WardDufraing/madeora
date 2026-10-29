import { registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { setGlobalProfile } from "../support/database";

// S30b: recurring goals. A monthly measurable series is previewed and created; its current period
// appears in Active with its badge and gets progress; the series page schedules a target change for
// the next period (the current period keeps its target), and the series is paused and resumed.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/Brussels",
  viewport: { width: 1280, height: 900 },
});

test("a monthly series: preview, current period with progress, next-period target, pause and resume", async ({
  page,
  baseURL,
}) => {
  const account = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(account.email, "Ward", "#2563eb");
  await signIn(page, account);
  await page.goto("/goals");

  // Create with a preview of the first and next periods.
  await page.getByTestId("goal-new").click();
  const form = page.getByTestId("goal-form");
  await form.getByTestId("goal-title").fill("Run every month");
  await form.getByTestId("goal-unit").selectOption("km");
  await form.getByTestId("goal-target").fill("40");
  await form.getByTestId("goal-repeat").selectOption("monthly");
  await expect(form.getByTestId("goal-save")).toHaveText("Preview periods");
  await form.getByTestId("goal-save").click();
  const preview = form.getByTestId("goal-series-preview");
  await expect(preview).toContainText("The first period starts now.");
  await expect(preview).toContainText("Next period:");
  expect(await axeViolations(page)).toEqual([]);
  await form.getByTestId("goal-save").click();

  // The series page shows the period running now.
  const detail = page.getByTestId("goal-series-detail");
  await expect(detail).toBeVisible();
  await expect(page.getByTestId("goal-series-state")).toHaveText("Active");
  await expect(page.getByTestId("goal-series-current")).toContainText("0 / 40 km");
  const seriesUrl = page.url();

  // The current period is in Active with its badge, and the series under Recurring.
  await page.goto("/goals");
  const card = page.getByTestId("goal-card");
  await expect(card).toContainText("Run every month");
  await expect(card).toContainText("Monthly");
  await expect(page.getByTestId("goal-series-card")).toContainText("Monthly · Active");

  // Progress on the period.
  await card.getByRole("link", { name: "Run every month" }).click();
  await expect(page.getByTestId("goal-period-line")).toBeVisible();
  await page.getByTestId("goal-add-progress").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("goal-add-amount").fill("12.5");
  await dialog.getByTestId("goal-add-save").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("goal-detail").getByTestId("goal-progress-text")).toHaveText(
    "12.5 / 40 km",
  );
  expect(await axeViolations(page)).toEqual([]);

  // A target change for the next period: the current one keeps its target.
  await page.getByTestId("goal-period-line").getByRole("link").click();
  await expect(page).toHaveURL(seriesUrl);
  await page.getByTestId("goal-series-change-target").click();
  const target = page.getByRole("dialog");
  await expect(target.getByTestId("goal-series-target-when")).toHaveValue("next");
  await target.getByTestId("goal-series-target-value").fill("50");
  await target.getByRole("button", { name: "Preview" }).click();
  await expect(target.getByTestId("goal-series-target-impact")).toContainText(
    "The current and earlier periods keep their target.",
  );
  await target.getByTestId("goal-series-target-save").click();
  await expect(target).toHaveCount(0);
  await expect(page.getByTestId("goal-series-targets")).toContainText("50 km");
  await expect(page.getByTestId("goal-series-current")).toContainText("12.5 / 40 km");

  // Pause, then resume.
  await page.getByTestId("goal-series-pause").click();
  await expect(page.getByTestId("goal-series-state")).toHaveText("Paused");
  await page.getByTestId("goal-series-resume").click();
  await expect(page.getByTestId("goal-series-state")).toHaveText("Active");
  await expect(page.getByTestId("goal-series-events")).toContainText("Resumed by you");
  await expect(page.getByTestId("goal-series-periods")).toContainText("12.5 / 40 km");
  expect(await axeViolations(page)).toEqual([]);
});
