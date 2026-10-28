import type { Page } from "@playwright/test";

import { registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { createHomeFor, setGlobalProfile } from "../support/database";

// S28b: personal points and rewards. A person with no Home adds points, defines a reward, redeems
// it and sees the new balance and the redemption; a second person sees none of it; a Home's points
// page never shows the personal balance; the personal dashboard widget; axe in both themes.
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

async function addPoints(page: Page, amount: number, reason: string) {
  await page.getByTestId("personal-adjust-open").click();
  await page.getByTestId("personal-adjust-amount").fill(String(amount));
  await page.getByTestId("personal-adjust-reason").fill(reason);
  await page.getByTestId("personal-adjust-next").click();
  await expect(page.getByTestId("personal-adjust-preview")).toBeVisible();
  await page.getByTestId("personal-adjust-confirm").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function createReward(page: Page, name: string, cost: number) {
  await page.getByTestId("personal-reward-new-open").click();
  const form = page.getByTestId("personal-reward-form");
  await form.getByTestId("personal-reward-name").fill(name);
  await form.getByTestId("personal-reward-cost").fill(String(cost));
  await form.getByTestId("personal-reward-save").click();
  await expect(page.getByTestId("personal-reward-form")).toHaveCount(0);
}

const rewardCard = (page: Page, name: string) =>
  page.getByTestId("personal-reward").filter({ hasText: name });

test("with no Home: add points, define a reward, redeem it, fulfil it; nobody else sees it", async ({
  page,
  baseURL,
  browser,
}) => {
  await newAdult(page, baseURL, "Ward");
  await page.goto("/points");
  await expect(page.getByTestId("personal-totals-available")).toHaveText("0");
  await addPoints(page, 40, "Finished the course");
  await expect(page.getByTestId("personal-totals-available")).toHaveText("40");
  await expect(page.getByTestId("personal-entry-amount").first()).toContainText("+40");

  await page.goto("/rewards");
  await createReward(page, "New book", 25);
  const book = rewardCard(page, "New book");
  await book.getByTestId("personal-redeem-open").click();
  await page.getByTestId("personal-redeem-next").click();
  await expect(page.getByTestId("personal-redeem-after")).toHaveText("15");
  await page.getByTestId("personal-redeem-confirm").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("personal-rewards-available")).toContainText("15");
  const redeemed = page.getByTestId("personal-redemption").first();
  await expect(redeemed.getByTestId("personal-redemption-status")).toContainText("Waiting");

  await redeemed.getByTestId("personal-fulfil-fulfilled-open").click();
  await page.getByTestId("personal-fulfil-fulfilled-next").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(redeemed.getByTestId("personal-redemption-status")).toContainText("Fulfilled");
  expect(await axeViolations(page)).toEqual([]);

  await page.goto("/points");
  await expect(page.getByTestId("personal-totals-available")).toHaveText("15");
  await expect(page.getByTestId("personal-totals-spent")).toHaveText("25");

  // Another person has their own empty ledger and catalog.
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    locale: "en-GB",
    timezoneId: "Europe/Brussels",
    viewport: { width: 1280, height: 900 },
  });
  const bea = await context.newPage();
  await newAdult(bea, baseURL, "Bea");
  await bea.goto("/points");
  await expect(bea.getByTestId("personal-totals-available")).toHaveText("0");
  await expect(bea.getByTestId("personal-entry")).toHaveCount(0);
  await bea.goto("/rewards");
  await expect(bea.getByText("New book")).toHaveCount(0);
  await context.close();
});

test("a Home's points stay separate, and the personal dashboard shows the personal balance", async ({
  page,
  baseURL,
}) => {
  const ward = await newAdult(page, baseURL, "Ward");
  await page.goto("/points");
  await addPoints(page, 12, "Morning run");

  const homeId = createHomeFor(ward.email, "Thuis");
  await page.goto(`/homes/${homeId}/points`);
  await expect(page.getByTestId("points-totals-available")).toHaveText("0");

  await page.goto("/?context=personal");
  await page.getByTestId("dashboard-customize").click();
  await page
    .getByTestId("dashboard-catalogue")
    .getByRole("button", { name: "Add Personal points" })
    .click();
  await page.getByTestId("dashboard-save").click();
  await expect(page.getByTestId("dashboard-editor")).toHaveCount(0);
  await expect(page.getByTestId("personal-points-widget-available")).toContainText("12");

  // The widget is offered on the personal surface only.
  await page.goto(`/homes/${homeId}`);
  await page.getByTestId("dashboard-customize").click();
  await expect(
    page.getByTestId("dashboard-catalogue").getByRole("button", { name: "Add Personal points" }),
  ).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`personal points and rewards pages pass axe in the ${scheme} theme`, async ({
    page,
    baseURL,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await newAdult(page, baseURL, "Ward");
    await page.goto("/points");
    expect(await axeViolations(page)).toEqual([]);
    await addPoints(page, 5, "A good day");
    await page.goto("/rewards");
    await createReward(page, "Cinema", 50);
    // Not enough points: the reason shows on the card.
    await expect(rewardCard(page, "Cinema").getByTestId("personal-reward-block")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });
}
