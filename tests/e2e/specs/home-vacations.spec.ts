import type { Browser, Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile } from "../support/database";

// S22: Home vacations. A member records their own vacation and their rotation turn passes to the
// next member; a chore manager records a whole-Home vacation, confirms the chore pause and decides
// a one-off chore it left for review; a member's suggestion is accepted by one invitee and declined
// by another; the Home vacation widget. Keyboard and axe in both themes.
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

const shift = (date: string, days: number) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

/** A weekly chore rotating Bea first, then the manager: today's turn is Bea's. */
async function addRotation(page: Page, title: string): Promise<void> {
  await page.getByTestId("new-chore-open").click();
  await page.getByLabel("Title").fill(title);
  await page.getByTestId("repeat-frequency").selectOption("weekly");
  await page.getByRole("radio", { name: "Rotation" }).check();
  await page.getByTestId("rotation-add-select").selectOption({ label: "Bea" });
  await page.getByTestId("rotation-add").click();
  await page.getByTestId("rotation-add-select").selectOption({ label: "you" });
  await page.getByTestId("rotation-add").click();
  await page.getByTestId("chore-submit").click();
  await expect(page.getByTestId("new-chore-view")).toBeVisible();
}

/** A one-off chore for one member, due on `due`. */
async function addOneOff(page: Page, title: string, member: string, due: string): Promise<void> {
  await page.getByTestId("new-chore-open").click();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Due date").fill(due);
  await page.getByRole("radio", { name: "Fixed members" }).check();
  await page.getByRole("checkbox", { name: member }).check();
  await page.getByTestId("chore-submit").click();
  await expect(page.getByTestId("new-chore-view")).toBeVisible();
}

/** Fills one stay row; the first row is the caller's own. */
async function fillRow(page: Page, index: number, from: string, to: string, member?: string) {
  const row = page.getByTestId("vacation-person-row").nth(index);
  if (member) await row.getByLabel("Member").selectOption({ label: member });
  await row.getByLabel("First day away").fill(from);
  await row.getByLabel("Last day away").fill(to);
}

const widget = (page: Page, name: string) =>
  page.getByTestId("dashboard-widget").filter({ has: page.getByRole("heading", { name }) });

test("a member's own vacation passes their rotation turn on; invitations accepted and declined", async ({
  page,
  browser,
  baseURL,
}) => {
  test.slow();
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  const bea = await otherAdult(browser, baseURL, "Bea");
  const cal = await otherAdult(browser, baseURL, "Cal");
  addMember(homeId, bea.account.email, "member");
  addMember(homeId, cal.account.email, "member");
  const chores = `/homes/${homeId}/chores`;
  const vacations = `/homes/${homeId}/vacations`;

  await page.goto(chores);
  await addRotation(page, "Take out the bins");

  // Bea is away from today: the preview says Ward takes her turn, and saving does it.
  await bea.page.goto(chores);
  await bea.page.getByTestId("chores-vacations-link").click();
  await expect(bea.page).toHaveURL(new RegExp(`${vacations}$`));
  await bea.page.getByTestId("vacation-new-open").click();
  const today = await bea.page
    .getByTestId("vacation-person-row")
    .first()
    .getByLabel("First day away")
    .getAttribute("min");
  expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const start = today ?? "";
  await fillRow(bea.page, 0, start, shift(start, 2));
  // She suggests Cal and Ward for the same days: they are invited, not added.
  await bea.page.getByTestId("vacation-add-row").click();
  await fillRow(bea.page, 1, shift(start, 1), shift(start, 2), "Cal");
  await bea.page.getByTestId("vacation-add-row").click();
  await fillRow(bea.page, 2, shift(start, 1), shift(start, 2), "Ward");
  await bea.page.getByLabel("Name (optional)").fill("Ski trip");
  await bea.page.getByTestId("vacation-new-preview").click();
  const impact = bea.page.getByTestId("vacation-impact");
  await expect(impact).toContainText("Take out the bins");
  await expect(impact).toContainText("Ward instead of you");
  expect(await axeViolations(bea.page)).toEqual([]);
  await bea.page.getByTestId("vacation-new-confirm").click();
  await expect(bea.page.getByText("Vacation saved.").first()).toBeAttached();
  await expect(bea.page.getByTestId("vacations-current")).toContainText("Ski trip");

  await page.goto(chores);
  await page.getByRole("link", { name: "Take out the bins" }).first().click();
  await expect(page.getByTestId("chore-assignees")).toContainText("you");

  // Cal accepts after seeing what changes for him; Ward declines.
  await cal.page.goto(vacations);
  const calRequest = cal.page.getByTestId("vacation-requests");
  await expect(calRequest).toContainText("Ski trip");
  await calRequest.getByTestId("vacation-invitation-accept").click();
  await expect(cal.page.getByTestId("vacation-impact")).toBeVisible();
  expect(await axeViolations(cal.page)).toEqual([]);
  await calRequest.getByTestId("vacation-invitation-confirm").click();
  await expect(cal.page.getByTestId("vacation-requests")).toHaveCount(0);

  await page.goto(vacations);
  await page.getByTestId("vacation-requests").getByTestId("vacation-invitation-decline").click();
  await expect(page.getByTestId("vacation-requests")).toHaveCount(0);

  await bea.page.goto(vacations);
  await bea.page.getByTestId("vacations-current").getByRole("link", { name: "Ski trip" }).click();
  await expect(bea.page.getByTestId("vacation-people")).toContainText("Cal");
  await expect(bea.page.getByTestId("vacation-others")).toContainText("Ward");
  await bea.close();
  await cal.close();
});

test("a whole-Home vacation: the pause, a one-off chore decided and the widget", async ({
  page,
  browser,
  baseURL,
}) => {
  test.slow();
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  const bea = await otherAdult(browser, baseURL, "Bea");
  addMember(homeId, bea.account.email, "member");
  const chores = `/homes/${homeId}/chores`;
  const vacations = `/homes/${homeId}/vacations`;

  await page.goto(vacations);
  await page.getByTestId("vacation-new-open").click();
  const start = shift(
    (await page
      .getByTestId("vacation-person-row")
      .first()
      .getByLabel("First day away")
      .getAttribute("min")) ?? "",
    1,
  );
  await page.getByTestId("vacation-new-form").getByRole("button", { name: "Cancel" }).click();

  // A one-off chore for Bea due during the vacation.
  await page.goto(chores);
  await addOneOff(page, "Water the plants", "Bea", shift(start, 1));

  // Ward records the vacation for both members; the reminder is optional.
  await page.goto(vacations);
  await page.getByTestId("vacation-new-open").click();
  await fillRow(page, 0, start, shift(start, 2));
  await page.getByTestId("vacation-add-row").click();
  await fillRow(page, 1, start, shift(start, 2), "Bea");
  await page.getByLabel("Name (optional)").fill("Coast");
  await page.getByTestId("vacation-new-preview").click();
  await expect(page.getByTestId("vacation-impact-review")).toContainText(
    "1 chore needs a decision",
  );
  await page.getByTestId("vacation-new-confirm").click();
  await expect(page.getByText("Vacation saved.").first()).toBeAttached();

  // Everyone is away: Ward confirms the Home-wide pause from the vacation's page.
  await page.getByTestId("vacations-current").getByRole("link", { name: "Coast" }).click();
  await expect(page.getByTestId("vacation-detail-pause")).toHaveText("Off");
  await page.getByTestId("vacation-pause-open").click();
  const pause = page.getByRole("dialog", { name: "Pause the Home's chores" });
  await pause.getByTestId("vacation-pause-next").click();
  await expect(pause.getByTestId("vacation-pause-impact")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await pause.getByTestId("vacation-pause-confirm").click();
  await expect(page.getByTestId("vacation-detail-pause")).not.toHaveText("Off");

  // The one-off chore waits for a decision; Ward skips it.
  const item = page.getByTestId("vacation-review-item").filter({ hasText: "Water the plants" });
  await item.getByTestId("decision-skip-open").click();
  await page.getByRole("dialog").getByTestId("decision-skip-next").click();
  // A skipped chore is closed, so it leaves the list.
  await expect(page.getByTestId("vacation-review-item")).toHaveCount(0);
  await expect(page.getByText("No chores need a decision.")).toBeVisible();

  // Ward adds the Home vacation widget to the Home dashboard; Bea sees it there.
  await page.goto(`/homes/${homeId}`);
  await page.getByTestId("dashboard-customize").click();
  await page
    .getByTestId("dashboard-catalogue")
    .getByRole("button", { name: "Add Home vacation" })
    .click();
  await page.getByTestId("dashboard-save").click();
  await expect(page.getByTestId("dashboard-editor")).toHaveCount(0);
  await bea.page.goto(`/homes/${homeId}`);
  const card = widget(bea.page, "Home vacation");
  await expect(card.getByTestId("vacation-widget")).toContainText("Coast");
  await expect(card.getByTestId("vacation-widget-scope")).toHaveText("Whole Home away");
  expect(await axeViolations(bea.page)).toEqual([]);
  await bea.close();
});

for (const scheme of ["light", "dark"] as const) {
  test(`recording a vacation by keyboard in the ${scheme} theme`, async ({ page, baseURL }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const ward = await newAdult(page, baseURL, "Ward");
    const homeId = createHomeFor(ward.email, "Thuis");
    await page.goto(`/homes/${homeId}/vacations`);
    expect(await axeViolations(page)).toEqual([]);
    await page.getByTestId("vacation-new-open").focus();
    await page.keyboard.press("Enter");
    await page.getByLabel("Name (optional)").fill("Weekend");
    await page.getByTestId("vacation-new-preview").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("vacation-impact")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.getByTestId("vacation-new-confirm").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("vacations-current")).toContainText("Weekend");
    await page.goto(`/homes/${homeId}/chores/absences`);
    expect(await axeViolations(page)).toEqual([]);
  });
}
