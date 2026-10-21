import type { Browser, Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, realtimeAvailable, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile } from "../support/database";

// S21: the pool of unassigned chores. Two members see the same pool; a claim by one leaves the
// other's page live (Supabase Realtime; the local fallback stack has none, so there the page is
// read again instead). Two simultaneous claims give exactly one winner. Undo, release from the
// occurrence page and a handover request accepted by its recipient. Keyboard and axe in both themes.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
  // The browser logs the deliberate refusal of the claim that lost the race.
  allowedConsoleErrors: [/status of 409/],
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

/** An unassigned one-off chore due today: it goes to the pool. */
async function addOneOff(page: Page, title: string): Promise<void> {
  await page.getByTestId("new-chore-open").click();
  await page.getByLabel("Title").fill(title);
  await page.getByTestId("chore-submit").click();
  await expect(page.getByTestId("new-chore-view")).toBeVisible();
}

/** Without Realtime (local fallback stack) another member's change shows after reading again. */
// Realtime delivery over the CI stack's first connections can take longer than the default wait.
const LIVE = { timeout: 20_000 };

async function catchUp(page: Page): Promise<void> {
  if (!realtimeAvailable) await page.reload();
}

function poolRow(page: Page, title: string) {
  return page.getByTestId("chore-pool").getByTestId("pool-row").filter({ hasText: title });
}

test("the pool: live claims, one winner, Undo, release and a handover", async ({
  page,
  browser,
  baseURL,
}) => {
  test.slow();
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  const bea = await secondAdult(browser, baseURL, "Bea");
  addMember(homeId, bea.account.email, "member");
  const base = `/homes/${homeId}/chores`;

  await page.goto(base);
  await addOneOff(page, "Water the plants");
  await page.goto(base);
  await addOneOff(page, "Sweep the hall");
  await page.goto(base);
  await expect(page.getByTestId("chore-pool").getByTestId("pool-row")).toHaveCount(2);
  // Unassigned chores show in the pool only, not again in the groups below.
  await expect(page.getByTestId("chore-row")).toHaveCount(0);

  await bea.page.goto(base);
  await expect(poolRow(bea.page, "Water the plants")).toHaveCount(1);
  expect(await axeViolations(bea.page)).toEqual([]);

  const idOf = async (title: string) =>
    ((await poolRow(page, title).getByRole("link").getAttribute("href")) ?? "").split("/").pop() ??
    "";
  const waterId = await idOf("Water the plants");
  const sweepId = await idOf("Sweep the hall");

  // Ward claims; the chore leaves Bea's pool while her page stays open.
  await poolRow(page, "Water the plants").getByTestId("chore-claim").click();
  await expect(page.getByText("You claimed Water the plants.").first()).toBeVisible();
  await expect(poolRow(page, "Water the plants")).toHaveCount(0);
  await catchUp(bea.page);
  await expect(poolRow(bea.page, "Water the plants")).toHaveCount(0, LIVE);

  // Undo puts it back, for both of them.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(
    page.getByText("Claim undone: Water the plants is back in the pool.").first(),
  ).toBeVisible();
  await expect(poolRow(page, "Water the plants")).toHaveCount(1);
  await catchUp(bea.page);
  await expect(poolRow(bea.page, "Water the plants")).toHaveCount(1, LIVE);

  // Both claim "Sweep the hall" at the same moment: exactly one wins, the other is told who has it.
  const claim = (target: Page) =>
    target.evaluate(async (id) => {
      const response = await fetch(`/api/v1/chore-occurrences/${id}/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return response.status;
    }, sweepId);
  const statuses = await Promise.all([claim(page), claim(bea.page)]);
  expect([...statuses].sort()).toEqual([200, 409]);
  await page.reload();
  await bea.page.reload();
  await expect(poolRow(page, "Sweep the hall")).toHaveCount(0);
  await expect(poolRow(bea.page, "Sweep the hall")).toHaveCount(0);

  // Bea claims "Water the plants", then releases it from its page: it is back in the pool.
  await poolRow(bea.page, "Water the plants").getByTestId("chore-claim").click();
  await expect(bea.page.getByText("You claimed Water the plants.").first()).toBeVisible();
  await bea.page.goto(`${base}/${waterId}`);
  await expect(bea.page.getByTestId("chore-claim-status")).toContainText("Claimed by you");
  await bea.page.getByTestId("chore-release-open").click();
  const release = bea.page.getByRole("dialog", { name: "Release this chore?" });
  expect(await axeViolations(bea.page)).toEqual([]);
  await release.getByTestId("chore-release-confirm").click();
  await expect(bea.page.getByTestId("chore-claim-status")).toContainText(
    "Unassigned: you can claim it.",
  );
  await catchUp(page);
  await expect(poolRow(page, "Water the plants")).toHaveCount(1, LIVE);

  // She claims it again from its page and asks Ward to take it over; Ward accepts.
  await bea.page.getByTestId("chore-claim").click();
  await expect(bea.page.getByTestId("chore-claim-status")).toContainText("Claimed by you");
  await bea.page.getByTestId("chore-request-open").click();
  const form = bea.page.getByTestId("chore-request-form");
  await form.getByLabel("Ask").selectOption({ label: "Ward" });
  await form.getByLabel("Note (optional)").fill("Away this weekend");
  await form.getByTestId("chore-request-send").click();
  await expect(bea.page.getByTestId("chore-request-status")).toBeVisible();

  await page.goto(base);
  const request = page.getByTestId("chore-requests").getByTestId("chore-request");
  await expect(request).toContainText("Water the plants");
  await expect(request).toContainText("Away this weekend");
  expect(await axeViolations(page)).toEqual([]);
  await request.getByRole("button", { name: "Accept taking over Water the plants" }).click();
  await expect(page.getByText("Accepted: Water the plants is yours now.").first()).toBeVisible();
  await page.goto(`${base}/${waterId}`);
  await expect(page.getByTestId("chore-assignees")).toContainText("you");
  await bea.close();
});

for (const scheme of ["light", "dark"] as const) {
  test(`claiming and Undo by keyboard in the ${scheme} theme`, async ({ page, baseURL }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const ward = await newAdult(page, baseURL, "Ward");
    const homeId = createHomeFor(ward.email, "Thuis");
    const base = `/homes/${homeId}/chores`;
    await page.goto(base);
    await addOneOff(page, "Fold the laundry");
    await page.goto(base);

    // The filters open and reset by keyboard.
    await page.getByTestId("pool-filters").locator("summary").focus();
    await page.keyboard.press("Enter");
    await page.getByLabel("Estimated time").selectOption("none");
    await expect(poolRow(page, "Fold the laundry")).toHaveCount(1);
    expect(await axeViolations(page)).toEqual([]);
    await page.getByTestId("pool-reset").press("Enter");

    await poolRow(page, "Fold the laundry").getByTestId("chore-claim").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("You claimed Fold the laundry.").first()).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "Undo" }).focus();
    await page.keyboard.press("Enter");
    await expect(poolRow(page, "Fold the laundry")).toHaveCount(1);
  });
}
