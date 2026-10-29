import type { Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { createHomeFor, setGlobalProfile } from "../support/database";

// S27: the meal planner. "Plan dinner" end to end (Project-entry): a published recipe is planned
// for today's dinner with more servings, its scaled ingredients go to a shopping list and an item
// is checked off there. Then a custom meal, a repeating breakfast with one occurrence edited on its
// own, copying the week, and the print preview with notes left out by default. Keyboard and axe.
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

/** Writes and publishes a recipe to the Home: 2 servings, tomatoes and an onion. */
async function publishSoup(page: Page, homeId: string): Promise<void> {
  const library = `/homes/${homeId}/recipes`;
  await page.goto(`${library}/new`);
  await expect(page.getByTestId("recipe-editor")).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Tomato soup");
  await page.getByLabel("Servings", { exact: true }).fill("2");
  const rows = page.getByTestId("ingredient-rows").getByRole("listitem");
  await rows.nth(0).getByLabel("Amount").fill("400");
  await rows.nth(0).getByLabel("Unit").selectOption("g");
  await rows.nth(0).getByLabel("Ingredient", { exact: true }).fill("tomatoes");
  await page.getByRole("button", { name: "Add ingredient" }).click();
  await rows.nth(1).getByLabel("Amount").fill("1");
  await rows.nth(1).getByLabel("Ingredient", { exact: true }).fill("onion");
  await page.getByLabel("Step 1", { exact: true }).fill("Simmer and blend.");
  await page.getByTestId("recipe-save-draft").click();
  await expect(page).toHaveURL(/\/recipes\/drafts\/[0-9a-f-]{36}$/);
  await page.getByTestId("recipe-publish").click();
  await page
    .getByRole("dialog", { name: "Publish this recipe?" })
    .getByRole("button", { name: "Publish to Thuis" })
    .click();
  await expect(page.getByTestId("recipe-detail")).toBeVisible();
}

function today(page: Page) {
  return page
    .locator('[data-testid^="meal-day-"]')
    .filter({ has: page.getByText("Today", { exact: true }) });
}

test("plan dinner: recipe, plan, transfer ingredients, check off", async ({ page, baseURL }) => {
  test.slow();
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  await publishSoup(page, homeId);

  // A shopping list to send the ingredients to.
  await page.goto(`/homes/${homeId}/shopping`);
  await page.getByTestId("new-shopping-list").click();
  await page.getByTestId("shopping-list-name").fill("Groceries");
  await page.getByTestId("shopping-list-create").click();
  await expect(page.getByRole("heading", { level: 1, name: "Groceries" })).toBeVisible();

  // The sidebar's Meals opens the Home's planner: Breakfast, Lunch and Dinner from the start.
  await page.goto(`/homes/${homeId}`);
  await page
    .getByRole("navigation", { name: /main/i })
    .getByRole("link", { name: "Meals" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/homes/${homeId}/meals$`));
  await expect(today(page).getByText("Breakfast")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // Plan the soup for tonight, for 4.
  await today(page)
    .getByRole("button", { name: /Add a meal to Dinner/ })
    .click();
  const dialog = page.getByTestId("meal-dialog");
  await expect(dialog.getByRole("option", { name: "Tomato soup" })).toBeAttached();
  await dialog.getByTestId("meal-recipe").selectOption({ label: "Tomato soup" });
  await dialog.getByTestId("meal-servings").fill("4");
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByTestId("meal-save").click();
  await expect(dialog).toBeHidden();
  await expect(today(page).getByRole("button", { name: /Tomato soup.*4 servings/ })).toBeVisible();

  // Its ingredients, scaled from 2 to 4 servings, go to Groceries.
  await page.getByTestId("meal-transfer-link").click();
  const rows = page.getByTestId("meal-transfer-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByLabel("Quantity")).toHaveValue("800");
  await expect(rows.nth(1).getByLabel("Quantity")).toHaveValue("2");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByTestId("meal-transfer-confirm").click();
  await expect(page.getByTestId("meal-transfer-results")).toContainText(
    "2 items added to Groceries.",
  );
  await page.getByTestId("meal-transfer-open-list").click();

  // And are checked off there like any other item.
  const tomatoes = page.getByTestId("shopping-item").filter({ hasText: "tomatoes" });
  await expect(tomatoes).toContainText("800 g");
  await tomatoes.getByTestId("shopping-item-check").click();
  await expect(page.getByTestId("shopping-completed")).toContainText("tomatoes");
});

test("custom and repeating meals, one occurrence edited, copy week and print", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  await page.goto(`/homes/${homeId}/meals`);

  // A custom lunch, by keyboard.
  await today(page)
    .getByRole("button", { name: /Add a meal to Lunch/ })
    .focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByTestId("meal-dialog");
  await dialog.getByTestId("meal-kind-custom").check();
  await dialog.getByTestId("meal-title").fill("Leftovers");
  await dialog.getByTestId("meal-notes").fill("Private note");
  await dialog.getByTestId("meal-title").press("Enter");
  await expect(dialog).toBeHidden();
  await expect(today(page).getByRole("button", { name: /Leftovers.*Custom meal/ })).toBeVisible();

  // Porridge every day for a week.
  await today(page)
    .getByRole("button", { name: /Add a meal to Breakfast/ })
    .click();
  await dialog.getByTestId("meal-kind-custom").check();
  await dialog.getByTestId("meal-title").fill("Porridge");
  await dialog.getByTestId("meal-repeat").selectOption("daily");
  const start = await dialog.getByTestId("meal-date").inputValue();
  const end = new Date(`${start}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  await dialog.getByTestId("meal-end-on").fill(end.toISOString().slice(0, 10));
  await dialog.getByTestId("meal-save").click();
  await expect(dialog.getByTestId("meal-collisions")).toContainText("Nothing else is planned");
  await dialog.getByTestId("meal-series-confirm").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("meal-series-list")).toContainText("Porridge");
  await expect(today(page).getByRole("button", { name: /Porridge.*Repeating/ })).toBeVisible();

  // Today's porridge becomes pancakes; the rest of the series stays porridge.
  await today(page)
    .getByRole("button", { name: /Porridge/ })
    .click();
  await expect(dialog.getByRole("radio", { name: /Only this meal/ })).toBeChecked();
  await dialog.getByTestId("meal-title").fill("Pancakes");
  await dialog.getByTestId("meal-save").click();
  await expect(dialog).toBeHidden();
  await expect(today(page).getByRole("button", { name: /Pancakes/ })).toBeVisible();
  await expect(today(page).getByRole("button", { name: /Porridge/ })).toHaveCount(0);
  expect(await page.getByRole("button", { name: /Porridge.*Repeating/ }).count()).toBeGreaterThan(
    0,
  );
  // Saving leaves the pointer on this row. Hover it on purpose so the contrast check
  // covers that state; axeViolations measures the row at rest.
  await page
    .getByRole("button", { name: /Porridge.*Repeating/ })
    .first()
    .hover();
  expect(await axeViolations(page)).toEqual([]);

  // Copy this week to the next one.
  await page.getByTestId("meal-copy-link").click();
  await expect(page.getByTestId("meal-copy-rows")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByTestId("meal-copy-confirm").click();
  await expect(page.getByTestId("meal-copy-results")).toContainText("copied");

  // Print preview: notes stay out until included; Print checks the plan first.
  await page.goto(`/homes/${homeId}/meals`);
  await page.getByTestId("meal-print-link").click();
  const preview = page.getByTestId("meal-print");
  await expect(preview).toContainText("Leftovers");
  await expect(preview).not.toContainText("Private note");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByTestId("meal-print-notes").check();
  await expect(preview).toContainText("Private note");
  await page.evaluate(() => {
    window.print = () => {
      document.body.dataset.printed = "yes";
    };
  });
  await page.getByTestId("meal-print-confirm").click();
  await expect(page.locator("body")).toHaveAttribute("data-printed", "yes");
});
