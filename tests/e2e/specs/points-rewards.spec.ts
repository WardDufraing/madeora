import type { Browser, Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile } from "../support/database";

// S23: points and rewards. A manager sets points on a chore; the assignee completes it and earns
// them; the manager adds a reward that needs approval; the assignee requests it (the cost is
// reserved), and the manager approves it (the reservation becomes spent). Another plain member
// sees only their own balance: the member list and someone else's ledger are refused by the API.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
  // The browser logs the deliberate refusals of the privacy checks.
  allowedConsoleErrors: [/status of 40[34]/],
});

async function newAdult(page: Page, baseURL: string | undefined, name: string): Promise<Account> {
  const account = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(account.email, name, "#2563eb");
  await signIn(page, account);
  return account;
}

async function secondAdult(
  browser: Browser,
  baseURL: string | undefined,
  name: string,
): Promise<{ page: Page; account: Account; close: () => Promise<void> }> {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    locale: "en-GB",
    timezoneId: "Europe/London",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const account = await newAdult(page, baseURL, name);
  return { page, account, close: () => context.close() };
}

test("chore points are earned, a requested reward is reserved and approved, balances stay private", async ({
  page,
  browser,
  baseURL,
}) => {
  test.slow();
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  const bea = await secondAdult(browser, baseURL, "Bea");
  addMember(homeId, bea.account.email, "member");
  const cal = await secondAdult(browser, baseURL, "Cal");
  addMember(homeId, cal.account.email, "member");
  const home = `/homes/${homeId}`;

  // Ward adds a one-off chore for Bea worth 20 points.
  await page.goto(`${home}/chores`);
  await page.getByTestId("new-chore-open").click();
  await page.getByLabel("Title").fill("Feed the cat");
  await page.getByRole("radio", { name: "Fixed members" }).check();
  await page.getByRole("checkbox", { name: "Bea" }).check();
  await page.getByTestId("chore-points").fill("20");
  await page.getByTestId("chore-submit").click();
  await expect(page.getByTestId("new-chore-view")).toBeVisible();

  // Bea completes it and earns the points.
  await bea.page.goto(`${home}/chores`);
  await bea.page
    .getByTestId("chore-row")
    .filter({ hasText: "Feed the cat" })
    .getByRole("link")
    .click();
  await expect(bea.page).toHaveURL(/\/chores\/[0-9a-f-]{36}/);
  await bea.page.getByTestId("chore-complete-open").click();
  await bea.page
    .getByRole("dialog", { name: "Complete this chore" })
    .getByTestId("chore-complete-confirm")
    .click();
  await expect(bea.page.getByTestId("chore-status")).toContainText("Done");
  await bea.page.goto(`${home}/points`);
  await expect(bea.page.getByTestId("points-totals-available")).toHaveText("20");
  await expect(bea.page.getByTestId("point-entry-amount").first()).toContainText("+20");
  // A plain member manages nobody's points.
  await expect(bea.page.getByTestId("points-accounts")).toHaveCount(0);
  expect(await axeViolations(bea.page)).toEqual([]);

  // Ward adds a reward that needs approval.
  await page.goto(`${home}/rewards`);
  await page.getByTestId("reward-new-open").click();
  await page.getByTestId("reward-name").fill("Movie night");
  await page.getByTestId("reward-cost-input").fill("15");
  await page.getByTestId("reward-requires-approval").check();
  await page.getByTestId("reward-save").click();
  await expect(page.getByTestId("reward").filter({ hasText: "Movie night" })).toHaveCount(1);

  // Bea requests it: the preview shows what remains, and the cost is reserved.
  await bea.page.goto(`${home}/rewards`);
  await bea.page.getByRole("button", { name: "Request: Movie night" }).click();
  const dialog = bea.page.getByRole("dialog", { name: "Redeem Movie night?" });
  await dialog.getByTestId("reward-redeem-next").click();
  await expect(dialog.getByTestId("reward-redeem-preview")).toContainText("Available after5");
  expect(await axeViolations(bea.page)).toEqual([]);
  await dialog.getByTestId("reward-redeem-confirm").click();
  await expect(bea.page.getByText("Request sent.").first()).toBeVisible();
  await expect(bea.page.getByTestId("rewards-available")).toContainText(
    "You have 5 points available (15 reserved).",
  );
  await expect(bea.page.getByTestId("redemption-status").first()).toHaveText(
    "Waiting for approval",
  );
  // Nobody approves their own request.
  await expect(bea.page.getByTestId("redemption-approve")).toHaveCount(0);

  // Ward approves it; the reservation becomes spent.
  await page.goto(`${home}/rewards/approvals`);
  await page.getByRole("button", { name: "Approve Movie night for Bea" }).click();
  await expect(page.getByTestId("reward-approvals")).toHaveCount(0);
  await bea.page.goto(`${home}/points`);
  await expect(bea.page.getByTestId("points-totals-available")).toHaveText("5");
  await expect(bea.page.getByTestId("points-totals-reserved")).toHaveText("0");
  await expect(bea.page.getByTestId("points-totals-spent")).toHaveText("15");

  // Ward, a points manager, sees Bea's account; Cal, a plain member, cannot read it.
  await page.goto(`${home}/points`);
  const beaRow = page.getByTestId("points-account").filter({ hasText: "Bea" });
  await expect(beaRow).toContainText("5");
  const ledgerHref = (await beaRow.getByRole("link").getAttribute("href")) ?? "";
  const accountId = new URL(ledgerHref, "http://x").searchParams.get("account") ?? "";
  expect(accountId).toMatch(/^[0-9a-f-]{36}$/);

  await cal.page.goto(`${home}/points`);
  await expect(cal.page.getByTestId("points-totals-available")).toHaveText("0");
  await expect(cal.page.getByTestId("points-accounts")).toHaveCount(0);
  const statuses = await cal.page.evaluate(
    async ({ homeId: id, account }) => {
      const list = await fetch(`/api/v1/points/accounts?homeId=${id}`);
      const ledger = await fetch(`/api/v1/points/accounts/${account}?homeId=${id}`);
      return [list.status, ledger.status];
    },
    { homeId, account: accountId },
  );
  expect(statuses[0]).toBeGreaterThanOrEqual(403);
  expect(statuses[1]).toBeGreaterThanOrEqual(403);
  // Opening the ledger by address shows Cal nothing of Bea's.
  await cal.page.goto(`${home}/points?account=${accountId}`);
  await expect(cal.page.getByTestId("points-account-totals")).toHaveCount(0);

  await bea.close();
  await cal.close();
});
