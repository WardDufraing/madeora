import type { Page } from "@playwright/test";

import { registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile } from "../support/database";

// S28: habits. A personal daily habit is completed, undone from the confirmation, backdated so the
// streak recalculates, corrected again and paused; a weekly Home habit shows its progress to a
// member, who completes it from the Home's Habits widget; insights and keyboard use with axe in
// both themes.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/Brussels",
  viewport: { width: 1280, height: 900 },
});

/** Today in Brussels, and a day `days` from it, as YYYY-MM-DD. */
function day(days = 0): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(
    new Date(),
  );
  const value = new Date(`${today}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function newAdult(page: Page, baseURL: string | undefined, name: string) {
  const account = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(account.email, name, "#2563eb");
  await signIn(page, account);
  return account;
}

async function createHabit(
  page: Page,
  name: string,
  startsOn: string,
  schedule: { kind: "daily" } | { kind: "weekly"; target: number },
) {
  await page.getByTestId("habit-new").click();
  const form = page.getByTestId("habit-form");
  await form.getByTestId("habit-name").fill(name);
  await form.getByTestId(`habit-kind-${schedule.kind}`).check();
  if (schedule.kind === "weekly") {
    await form.getByTestId("habit-target").selectOption(String(schedule.target));
  }
  await form.getByTestId("habit-starts-on").fill(startsOn);
  await form.getByTestId("habit-save").click();
  // A new habit opens on its own page.
  await expect(page.getByTestId("habit-detail")).toBeVisible();
}

const card = (page: Page, name: string) =>
  page.getByTestId("habit-card").filter({ has: page.getByRole("heading", { name }) });

test("a personal habit: complete, Undo, backdating restores the streak, pause", async ({
  page,
  baseURL,
}) => {
  await newAdult(page, baseURL, "Ward");
  await page.goto("/habits");
  await createHabit(page, "Stretch", day(-5), { kind: "daily" });
  await page.goto("/habits");
  const stretch = card(page, "Stretch");
  await expect(stretch.getByTestId("habit-streak")).toHaveText("No current streak");

  // Complete, then Undo from the confirmation.
  await stretch.getByRole("button", { name: "Complete Stretch for today" }).click();
  await expect(stretch.getByTestId("habit-streak")).toHaveText("1 time in a row");
  await page.getByRole("button", { name: "Undo", exact: true }).first().click();
  await expect(stretch.getByTestId("habit-streak")).toHaveText("No current streak");

  // Today and two backdated days: three in a row.
  await stretch.getByRole("button", { name: "Complete Stretch for today" }).click();
  await expect(stretch.getByTestId("habit-streak")).toHaveText("1 time in a row");
  await stretch.getByRole("link", { name: "Stretch" }).click();
  await expect(page.getByTestId("habit-detail")).toBeVisible();
  const recent = page.getByTestId("habit-recent");
  for (const back of [-1, -2]) {
    await recent.getByTestId("habit-day").nth(-back).getByTestId("habit-day-complete").click();
    // An earlier day is confirmed first, showing the day and its state.
    await expect(page.getByTestId("habit-backdate")).toContainText("Missed");
    await page.getByTestId("habit-backdate-confirm").click();
    await expect(recent.getByTestId("habit-day").nth(-back)).toHaveAttribute(
      "data-state",
      "completed",
    );
  }
  await expect(page.getByTestId("habit-current-streak")).toContainText("3 times in a row");

  // Undoing yesterday breaks the streak; completing it again restores it.
  await recent.getByTestId("habit-day").nth(1).getByTestId("habit-day-undo").click();
  await expect(page.getByTestId("habit-current-streak")).toContainText("1 time in a row");
  await recent.getByTestId("habit-day").nth(1).getByTestId("habit-day-complete").click();
  await page.getByTestId("habit-backdate-confirm").click();
  await expect(page.getByTestId("habit-current-streak")).toContainText("3 times in a row");
  await expect(page.getByText("Your current streak went from 1 to 3.").first()).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // A pause until resumed: the streak stays, today shows as paused.
  await page.getByTestId("habit-pause").click();
  await page.getByTestId("habit-pause-submit").click();
  await expect(page.getByTestId("habit-preview")).toBeVisible();
  await page.getByTestId("habit-pause-submit").click();
  await expect(page.getByTestId("habit-status")).toContainText("Paused until resumed");
  await expect(page.getByTestId("habit-current-streak")).toContainText("3 times in a row");
});

test("a weekly Home habit: progress, a member completes it from the widget", async ({
  page,
  baseURL,
  browser,
}) => {
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  await page.goto(`/homes/${homeId}/habits`);
  await createHabit(page, "Plants", day(0), { kind: "weekly", target: 2 });
  await page.goto(`/homes/${homeId}/habits`);
  await expect(card(page, "Plants").getByTestId("habit-week-progress")).toContainText(
    /0 of [12] this week/,
  );

  // Ward adds the Habits widget to the Home dashboard.
  await page.goto(`/homes/${homeId}`);
  await page.getByTestId("dashboard-customize").click();
  await page.getByTestId("dashboard-catalogue").getByRole("button", { name: "Add Habits" }).click();
  await page.getByTestId("dashboard-save").click();
  await expect(page.getByTestId("dashboard-editor")).toHaveCount(0);

  // Bea, a member, completes it from the widget; members check in by default.
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
  const widget = bea.getByTestId("habits-widget");
  await widget.getByRole("button", { name: "Complete Plants for today" }).click();
  await expect(widget.getByTestId("habit-today-done")).toContainText("Done today by you");
  await expect(widget.getByTestId("habit-week-progress")).toContainText(/1 of [12] this week/);
  expect(await axeViolations(bea)).toEqual([]);

  // Ward sees who completed it, and the insights.
  await page.goto(`/homes/${homeId}/habits`);
  await expect(card(page, "Plants").getByTestId("habit-today-done")).toContainText("Bea");
  await card(page, "Plants").getByRole("link", { name: "Plants" }).click();
  await expect(page.getByTestId("habit-detail")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await context.close();
});

for (const scheme of ["light", "dark"] as const) {
  test(`creating and completing a habit by keyboard in the ${scheme} theme`, async ({
    page,
    baseURL,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await newAdult(page, baseURL, "Ward");
    await page.goto("/habits");
    expect(await axeViolations(page)).toEqual([]);
    await page.getByTestId("habit-new").focus();
    await page.keyboard.press("Enter");
    // The dialog opens on its Close button; the name is next.
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("habit-name")).toBeFocused();
    await page.keyboard.type("Read");
    await page.getByTestId("habit-save").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("habit-detail")).toBeVisible();
    await page.goto("/habits");
    const read = card(page, "Read");
    await read.getByRole("button", { name: "Complete Read for today" }).focus();
    await page.keyboard.press("Enter");
    await expect(read.getByTestId("habit-streak")).toHaveText("1 time in a row");
    expect(await axeViolations(page)).toEqual([]);
  });
}
