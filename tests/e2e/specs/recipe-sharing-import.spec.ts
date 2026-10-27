import type { Browser, Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile } from "../support/database";

// S25: recipe sharing and import. The Owner shares a recipe of one Home with another Home: a member
// there sees the same recipe, marked as shared, and can neither edit nor delete it. Deleting it
// first shows the impact review, naming the Home it is shared with. Importing from a private
// address is refused by the real server with the reason and a way to enter it by hand; an import
// (its answer stubbed, since the test server's own pages are private addresses) opens the review,
// and publishing it keeps the source. axe on the share panel and the import review.
// Homes are set up directly in the throwaway test database.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
  // The browser logs the deliberate refusals (the member deleting, the blocked import).
  allowedConsoleErrors: [/status of (403|404|422)/],
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

/** Writes and publishes a small recipe in a Home; answers its id. */
async function publishSoup(page: Page, homeId: string, homeName: string): Promise<string> {
  await page.goto(`/homes/${homeId}/recipes/new`);
  await expect(page.getByTestId("recipe-editor")).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Tomato soup");
  await page.getByLabel("Servings", { exact: true }).fill("2");
  const rows = page.getByTestId("ingredient-rows").getByRole("listitem");
  await rows.nth(0).getByLabel("Ingredient", { exact: true }).fill("tomatoes");
  await page.getByLabel("Step 1", { exact: true }).fill("Simmer.");
  await page.getByTestId("recipe-publish").click();
  await page
    .getByRole("dialog", { name: "Publish this recipe?" })
    .getByRole("button", { name: `Publish to ${homeName}` })
    .click();
  await expect(page).toHaveURL(new RegExp(`/homes/${homeId}/recipes/[0-9a-f-]{36}$`));
  return page.url().split("/").pop() ?? "";
}

test("sharing a recipe with another Home, what members there may do, and the impact review", async ({
  page,
  browser,
  baseURL,
}) => {
  test.slow();
  const ward = await newAdult(page, baseURL, "Ward");
  const thuis = createHomeFor(ward.email, "Thuis");
  const strand = createHomeFor(ward.email, "Strand");
  const bea = await secondAdult(browser, baseURL, "Bea");
  addMember(strand, bea.account.email, "member");
  const recipeId = await publishSoup(page, thuis, "Thuis");

  // Not shared yet: Bea, in Strand only, finds nothing.
  await bea.page.goto(`/homes/${strand}/recipes`);
  await expect(bea.page.getByText("No recipes yet")).toBeVisible();
  const before = await bea.page.request.get(`/api/v1/recipes/${recipeId}?homeId=${strand}`);
  expect(before.status()).toBe(404);

  // Ward shares it with Strand, after the consequences are shown.
  await page.getByTestId("recipe-share").click();
  await expect(page).toHaveURL(new RegExp(`/recipes/${recipeId}/share$`));
  await expect(page.getByText("This recipe is not shared with any other Home.")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByTestId("recipe-share-home").selectOption(strand);
  await page.getByTestId("recipe-share-submit").click();
  const confirm = page.getByRole("dialog", { name: "Share with Strand?" });
  await expect(confirm).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await confirm.getByTestId("recipe-share-confirm").click();
  await expect(page.getByText("Sharing updated.")).toBeVisible();
  await expect(page.getByTestId("recipe-shares")).toContainText("Strand");

  // Bea sees the same recipe, marked as shared; she can favorite it but not edit or delete it.
  await bea.page.goto(`/homes/${strand}/recipes`);
  const card = bea.page.getByTestId("recipe-card").filter({ hasText: "Tomato soup" });
  await expect(card).toContainText("Shared");
  await card.getByRole("link").first().click();
  await expect(bea.page).toHaveURL(new RegExp(`/homes/${strand}/recipes/${recipeId}$`));
  await expect(bea.page.getByTestId("recipe-shared-in")).toBeVisible();
  await expect(bea.page.getByTestId("recipe-edit")).toHaveCount(0);
  await expect(bea.page.getByTestId("recipe-delete")).toHaveCount(0);
  await expect(bea.page.getByTestId("recipe-share")).toHaveCount(0);
  await bea.page.getByTestId("recipe-favorite").click();
  await expect(bea.page.getByTestId("recipe-favorite")).toHaveAttribute("aria-pressed", "true");
  expect(await axeViolations(bea.page)).toEqual([]);
  const refused = await bea.page.request.delete(`/api/v1/recipes/${recipeId}`, {
    data: {},
    headers: { origin: baseURL ?? "" },
  });
  expect(refused.status()).toBe(403);

  // Deleting first reviews the impact: the Home it is shared with and its favorite.
  await page.goto(`/homes/${thuis}/recipes/${recipeId}`);
  await page.getByTestId("recipe-delete").click();
  const review = page.getByRole("dialog");
  await expect(review.getByTestId("recipe-impact-homes")).toContainText("Strand");
  await expect(review.getByRole("button", { name: "Delete everywhere" })).toBeEnabled();
  expect(await axeViolations(page)).toEqual([]);
  await review.getByRole("button", { name: "Cancel" }).click();
  await expect(review).toBeHidden();
  await bea.close();
});

test("importing: a private address is refused, a reviewed import is published with its source", async ({
  page,
  baseURL,
}) => {
  const ward = await newAdult(page, baseURL, "Ward");
  const thuis = createHomeFor(ward.email, "Thuis");

  // The real server refuses a private address, says why and offers manual entry.
  await page.goto(`/homes/${thuis}/recipes`);
  await page.getByRole("link", { name: "Import from a website" }).click();
  await expect(page).toHaveURL(new RegExp(`/homes/${thuis}/recipes/import$`));
  await expect(page.getByTestId("recipe-import-destination")).toHaveValue(thuis);
  expect(await axeViolations(page)).toEqual([]);
  await page.getByLabel("Web address of the recipe").fill("http://127.0.0.1/admin");
  await page.getByTestId("recipe-import-submit").click();
  const failure = page.getByTestId("recipe-import-failure");
  await expect(failure).toContainText("private or local network");
  await expect(failure.getByTestId("recipe-import-manual")).toHaveAttribute(
    "href",
    `/homes/${thuis}/recipes/new`,
  );

  // A readable page (its answer stubbed): the review, then the ordinary editor.
  await page.route("**/api/v1/recipes/import", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        source: { url: "https://recipes.example/stoofvlees", name: "Recipes Example · Sam" },
        name: "Stoofvlees",
        servings: 4,
        servingsLabel: null,
        prepMinutes: 20,
        cookMinutes: 180,
        notes: null,
        tags: ["Vlaams"],
        ingredients: [
          { name: "rundvlees", quantity: "1", unit: "kg", asWritten: false },
          { name: "2-3 uien", quantity: "", unit: null, asWritten: true },
        ],
        steps: ["Braise slowly."],
        warnings: ["ingredientsAsWritten", "photoNotCopied"],
        duplicates: [],
      }),
    }),
  );
  await page.getByLabel("Web address of the recipe").fill("https://recipes.example/stoofvlees");
  await page.getByTestId("recipe-import-submit").click();
  await expect(page.getByRole("heading", { name: "Check the imported recipe" })).toBeFocused();
  await expect(page.getByTestId("recipe-import-warnings")).toContainText("kept as written");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Stoofvlees");
  expect(await axeViolations(page)).toEqual([]);

  // Nothing is saved until the person publishes.
  await page.goto(`/homes/${thuis}/recipes`);
  await expect(page.getByText("No recipes yet")).toBeVisible();
  await page.goto(`/homes/${thuis}/recipes/import`);
  await page.getByLabel("Web address of the recipe").fill("https://recipes.example/stoofvlees");
  await page.getByTestId("recipe-import-submit").click();
  await page.getByTestId("recipe-publish").click();
  await page
    .getByRole("dialog", { name: "Publish this recipe?" })
    .getByRole("button", { name: "Publish to Thuis" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/homes/${thuis}/recipes/[0-9a-f-]{36}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Stoofvlees");
  const detail = page.getByTestId("recipe-detail");
  await expect(
    detail.getByRole("link", { name: /Recipes Example · Sam \(recipes\.example\)/ }),
  ).toHaveAttribute("href", "https://recipes.example/stoofvlees");
});
