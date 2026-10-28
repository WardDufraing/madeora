import type { Browser, Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, realtimeAvailable, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile } from "../support/database";

// S26: shopping lists. Two members of a Home: one checks an item off and the other sees it move
// to Completed without reloading (Supabase Realtime; the local fallback stack has none, so there
// the page is read again instead). Quick add with the duplicate question, Add several with its
// review, a category, a move to another list, and the Shopping widget combining two lists with
// their names. Keyboard and axe.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
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

// Realtime delivery over the CI stack's first connections can take longer than the default wait.
const LIVE = { timeout: 20_000 };

async function catchUp(page: Page): Promise<void> {
  if (!realtimeAvailable) await page.reload();
}

async function createList(page: Page, base: string, name: string): Promise<string> {
  await page.goto(base);
  await page.getByTestId("new-shopping-list").click();
  await page.getByTestId("shopping-list-name").fill(name);
  await page.getByTestId("shopping-list-create").click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return page.url().split("/").pop() ?? "";
}

async function quickAdd(page: Page, name: string): Promise<void> {
  await page.getByTestId("shopping-quick-add").fill(name);
  await page.getByTestId("shopping-quick-add-submit").click();
  await expect(page.getByTestId("shopping-quick-add")).toHaveValue("");
}

function activeItem(page: Page, name: string) {
  return page.getByTestId("shopping-item").filter({ hasText: name });
}

test("shopping lists: live check-off, quick add, add several, categories, moves, widget", async ({
  page,
  browser,
  baseURL,
}) => {
  test.slow();
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  const bea = await secondAdult(browser, baseURL, "Bea");
  addMember(homeId, bea.account.email, "member");
  const base = `/homes/${homeId}/shopping`;

  // No list exists until someone makes one.
  await page.goto(base);
  await expect(page.getByText("No shopping lists yet")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  const groceries = await createList(page, base, "Groceries");
  const listPath = `${base}/${groceries}`;

  // Quick add, and the duplicate question (nothing is merged).
  await quickAdd(page, "Milk");
  await quickAdd(page, "Bread");
  await page.getByTestId("shopping-quick-add").fill("milk");
  await page.getByTestId("shopping-quick-add-submit").click();
  await expect(
    page.getByText("milk is already on the list. Add it again as a separate item?"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(activeItem(page, "Milk")).toHaveCount(1);

  // Add several: reviewed, a doubtful line flagged, quantities read only when clear.
  await page.getByTestId("shopping-add-several").click();
  await page.getByTestId("shopping-add-several-text").fill("500 g pasta\n\n2-3 onions\n6 apples");
  await page.getByTestId("shopping-add-several-review").click();
  const rows = page.getByTestId("shopping-preview-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText("Check this line.");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByTestId("shopping-add-several-commit").click();
  await expect(page).toHaveURL(new RegExp(`${listPath}$`));
  await expect(activeItem(page, "pasta")).toContainText("500 g pasta");
  await expect(activeItem(page, "apples")).toContainText("6 apples");
  await expect(activeItem(page, "2-3 onions")).toHaveCount(1);

  // A category, and an item put in it.
  await page.getByTestId("shopping-categories").click();
  await page.getByTestId("shopping-category-name").fill("Dairy");
  await page.getByTestId("shopping-category-add").click();
  await expect(page.getByTestId("shopping-category")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await activeItem(page, "Milk").getByTestId("shopping-item-edit").click();
  await page.getByTestId("shopping-item-quantity").fill("1,5");
  await page.getByTestId("shopping-item-unit").selectOption("l");
  await page.getByTestId("shopping-item-category").selectOption({ label: "Dairy" });
  await page.getByTestId("shopping-item-save").click();
  await expect(page.getByRole("heading", { level: 3, name: "Dairy" })).toBeVisible();
  await expect(activeItem(page, "Milk")).toContainText("1.5 l Milk");

  // Bea opens the same list; Ward checks Bread off and it moves to Completed on her open page.
  await bea.page.goto(listPath);
  await expect(activeItem(bea.page, "Bread")).toHaveCount(1);
  expect(await axeViolations(bea.page)).toEqual([]);
  await activeItem(page, "Bread").getByTestId("shopping-item-check").click();
  await expect(page.getByTestId("shopping-completed")).toContainText("Bread");
  await catchUp(bea.page);
  await expect(bea.page.getByTestId("shopping-completed")).toContainText("Bread", LIVE);
  await expect(bea.page.getByTestId("shopping-completed")).toContainText("Completed by Ward");
  await expect(activeItem(bea.page, "Bread")).toHaveCount(0);

  // Keyboard: Bea checks Milk off with the space bar; Ward sees it.
  await activeItem(bea.page, "Milk").getByTestId("shopping-item-check").focus();
  await bea.page.keyboard.press("Space");
  await expect(bea.page.getByTestId("shopping-completed")).toContainText("Milk");
  await catchUp(page);
  await expect(page.getByTestId("shopping-completed")).toContainText("Completed by Bea", LIVE);

  // A second list; apples move there (same Home only).
  const pharmacy = await createList(page, base, "Pharmacy");
  await page.goto(listPath);
  await activeItem(page, "apples").getByTestId("shopping-item-edit").click();
  await page.getByTestId("shopping-item-transfer").click();
  await page.getByTestId("shopping-transfer-destination").selectOption({ label: "Pharmacy" });
  await page.getByTestId("shopping-transfer-confirm").click();
  await expect(page.getByText("apples moved to Pharmacy.").first()).toBeVisible();
  await expect(activeItem(page, "apples")).toHaveCount(0);
  await page.goto(`${base}/${pharmacy}`);
  await expect(activeItem(page, "apples")).toHaveCount(1);

  // The Home dashboard: one Shopping widget combining both lists, with each row's list.
  await page.goto(`/homes/${homeId}`);
  await page.getByTestId("dashboard-customize").click();
  await page
    .getByTestId("dashboard-catalogue")
    .getByRole("button", { name: "Add Shopping" })
    .click();
  await page.getByRole("button", { name: "Arrange Shopping" }).click();
  const settings = page.getByTestId("shopping-widget-settings");
  await settings.getByTestId("shopping-widget-add-list").selectOption({ label: "Groceries" });
  await settings.getByTestId("shopping-widget-add-list").selectOption({ label: "Pharmacy" });
  await settings.getByTestId("shopping-widget-quick-add").selectOption({ label: "Groceries" });
  await page.getByTestId("dashboard-save").click();
  await expect(page.getByTestId("dashboard-editor")).toHaveCount(0);
  const widget = page.getByTestId("shopping-widget");
  await expect(
    widget.getByTestId("shopping-widget-item").filter({ hasText: "pasta" }),
  ).toContainText("Groceries");
  await expect(
    widget.getByTestId("shopping-widget-item").filter({ hasText: "apples" }),
  ).toContainText("Pharmacy");
  await expect(widget.getByText("Bread")).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);

  await bea.close();
});
