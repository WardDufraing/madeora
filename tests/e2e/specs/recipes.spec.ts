import type { Browser, Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile } from "../support/database";

// S24: recipes core. The Owner writes a recipe as a private draft, which a member of the Home cannot
// find; publishing it to the Home shows it to that member, who favorites and rates it. While the
// Owner edits, the recipe is locked: a second tab of the Owner and the member both see who is
// editing. Cooking mode scales the ingredients and steps through the recipe; the Home dashboard's
// Recipes widget shows each viewer their own favorites. axe in both themes.
// Homes are set up directly in the throwaway test database (invitations are covered elsewhere).
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
  // The browser logs the deliberate refusals (the member asking for the draft, the locked editor).
  allowedConsoleErrors: [/status of (403|404|409)/],
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

/** Fills a new recipe: two ingredients (one without an amount) and two steps. */
async function fillPancakes(page: Page): Promise<void> {
  const editor = page.getByTestId("recipe-editor");
  await expect(editor).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Pancakes");
  await page.getByLabel("Servings", { exact: true }).fill("4");
  const rows = page.getByTestId("ingredient-rows").getByRole("listitem");
  await rows.nth(0).getByLabel("Amount").fill("200");
  await rows.nth(0).getByLabel("Unit").selectOption("g");
  await rows.nth(0).getByLabel("Ingredient", { exact: true }).fill("flour");
  await page.getByRole("button", { name: "Add ingredient" }).click();
  await rows.nth(1).getByLabel("Ingredient", { exact: true }).fill("salt");
  await page.getByLabel("Step 1", { exact: true }).fill("Mix everything.");
  await page.getByRole("button", { name: "Add step" }).click();
  await page.getByLabel("Step 2", { exact: true }).fill("Fry in a pan.");
}

test("a draft stays private, publishing shares it, the lock, cooking mode and the widget", async ({
  page,
  browser,
  baseURL,
}) => {
  // A long journey through several pages and three tabs.
  test.slow();
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  const bea = await secondAdult(browser, baseURL, "Bea");
  addMember(homeId, bea.account.email, "member");
  const library = `/homes/${homeId}/recipes`;

  // The sidebar's Meals opens the open Home's recipes.
  await page.goto(`/homes/${homeId}`);
  await page
    .getByRole("navigation", { name: /main/i })
    .getByRole("link", { name: "Meals" })
    .click();
  await expect(page).toHaveURL(new RegExp(`${library}$`));
  await expect(page.getByText("No recipes yet")).toBeVisible();

  // A draft: saved privately, with the Home as where it will go.
  await page.goto(`${library}/new`);
  await expect(page.getByTestId("recipe-destination")).toHaveValue(homeId);
  await fillPancakes(page);
  await page.getByTestId("recipe-save-draft").click();
  await expect(page.getByText("Draft saved. Only you can see it.")).toBeVisible();
  await expect(page).toHaveURL(/\/recipes\/drafts\/[0-9a-f-]{36}$/);
  const recipeId = page.url().split("/").pop() ?? "";
  await page.goto("/recipes/drafts");
  await expect(page.getByTestId("recipe-drafts")).toContainText("Pancakes");
  await expect(page.getByTestId("recipe-drafts")).toContainText("Will be published to: Thuis");

  // Bea, in the same Home, finds nothing: not in the library, not by its address, not by the API.
  await bea.page.goto(library);
  await expect(bea.page.getByText("No recipes yet")).toBeVisible();
  const asked = await bea.page.request.get(`/api/v1/recipes/${recipeId}`);
  expect(asked.status()).toBe(404);
  await bea.page.goto(`/recipes/drafts/${recipeId}`);
  await expect(bea.page.getByTestId("recipe-editor")).toHaveCount(0);
  await expect(bea.page.getByText("Pancakes")).toHaveCount(0);
  await bea.page.goto(`${library}/${recipeId}`);
  await expect(bea.page.getByTestId("recipe-detail")).toHaveCount(0);

  // Publishing names who will see it.
  await page.goto(`/recipes/drafts/${recipeId}`);
  await page.getByTestId("recipe-publish").click();
  const publish = page.getByRole("dialog", { name: "Publish this recipe?" });
  await expect(publish).toContainText("Everyone in Thuis can see it.");
  expect(await axeViolations(page)).toEqual([]);
  await publish.getByRole("button", { name: "Publish to Thuis" }).click();
  await expect(page).toHaveURL(new RegExp(`${library}/${recipeId}$`));
  await expect(page.getByTestId("recipe-detail")).toContainText("Added by you");

  // Bea sees it now, favorites it and rates it.
  await bea.page.goto(library);
  const card = bea.page.getByTestId("recipe-card").filter({ hasText: "Pancakes" });
  await expect(card).toHaveCount(1);
  await card.getByRole("link").first().click();
  await expect(bea.page).toHaveURL(new RegExp(`${library}/${recipeId}$`));
  await expect(bea.page.getByTestId("recipe-detail")).toContainText("Added by Ward");
  await expect(bea.page.getByRole("link", { name: "Edit" })).toHaveCount(0);
  const favorite = bea.page.getByTestId("recipe-favorite");
  await favorite.click();
  await expect(favorite).toHaveAttribute("aria-pressed", "true");
  // The stars are labels around visually hidden radio buttons.
  await bea.page
    .getByTestId("recipe-rating")
    .locator("label")
    .filter({ hasText: "4 stars" })
    .click();
  await expect(bea.page.getByRole("radio", { name: "4 stars" })).toBeChecked();
  await expect(bea.page.getByTestId("rating-summary")).toContainText("4 out of 5 · 1 rating");
  expect(await axeViolations(bea.page)).toEqual([]);
  await bea.page.reload();
  await expect(bea.page.getByTestId("recipe-favorite")).toHaveAttribute("aria-pressed", "true");
  await bea.page.goto(`${library}?favorites=1`);
  await expect(bea.page.getByTestId("recipe-card")).toHaveCount(1);

  // Ward edits: his second tab and Bea both see that the recipe is being edited.
  await page.goto(`${library}/${recipeId}/edit`);
  await expect(page.getByTestId("recipe-save")).toBeEnabled();
  const second = await page.context().newPage();
  await second.goto(`${library}/${recipeId}/edit`);
  await expect(second.getByTestId("recipe-locked")).toContainText(
    "You are editing this recipe in another tab or on another device.",
  );
  await expect(second.getByTestId("recipe-take-over")).toBeVisible();
  await second.close();
  await bea.page.goto(`${library}/${recipeId}`);
  await expect(bea.page.getByTestId("recipe-lock-notice")).toContainText(
    "Ward is editing this recipe right now.",
  );
  await page.getByLabel("Name", { exact: true }).fill("Thin pancakes");
  await page.getByTestId("recipe-save").click();
  await expect(page).toHaveURL(new RegExp(`${library}/${recipeId}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Thin pancakes" })).toBeVisible();
  // Saving ended the edit: the notice is gone.
  await bea.page.reload();
  await expect(bea.page.getByRole("heading", { level: 1, name: "Thin pancakes" })).toBeVisible();
  await expect(bea.page.getByTestId("recipe-lock-notice")).toHaveCount(0);

  // Cooking mode: twice the servings, exact amounts, the unscaled ingredient labelled.
  await bea.page.getByRole("link", { name: "Start cooking" }).click();
  await expect(bea.page.getByTestId("cooking-mode")).toBeVisible();
  await expect(bea.page.getByTestId("cooking-step-count")).toHaveText("Step 1 of 2");
  await expect(bea.page.getByTestId("cooking-step")).toHaveText("Mix everything.");
  await bea.page.getByTestId("servings-input").fill("8");
  await expect(bea.page.getByTestId("servings-summary")).toContainText(
    "Amounts scaled to 8 servings (the recipe makes 4).",
  );
  const ingredients = bea.page.getByTestId("recipe-ingredients").getByRole("listitem");
  await expect(ingredients.nth(0)).toContainText("400 g flour");
  await expect(ingredients.nth(1)).toContainText("salt (no amount, not scaled)");
  await expect(bea.page).toHaveURL(/servings=8/);
  await bea.page.getByRole("checkbox", { name: /flour/ }).check();
  await bea.page.getByTestId("cooking-next").click();
  await expect(bea.page.getByTestId("cooking-step-count")).toHaveText("Step 2 of 2");
  await expect(bea.page.getByTestId("cooking-step-count")).toBeFocused();
  await expect(bea.page.getByTestId("cooking-next")).toBeDisabled();
  expect(await axeViolations(bea.page)).toEqual([]);
  // The step and the checklist stay in this tab across a reload.
  await bea.page.reload();
  await expect(bea.page.getByTestId("cooking-step-count")).toHaveText("Step 2 of 2");
  await expect(bea.page.getByRole("checkbox", { name: /flour/ })).toBeChecked();

  // The Home dashboard's Recipes widget: Bea's favorite for her, nothing yet for Ward.
  await page.goto(`/homes/${homeId}`);
  await page.getByTestId("dashboard-customize").click();
  await page
    .getByTestId("dashboard-catalogue")
    .getByRole("button", { name: "Add Recipes" })
    .click();
  await page.getByTestId("dashboard-save").click();
  await expect(page.getByTestId("dashboard-editor")).toHaveCount(0);
  await expect(page.getByTestId("recipe-widget")).toContainText("No favorites yet");
  await bea.page.goto(`/homes/${homeId}`);
  await expect(
    bea.page.getByTestId("recipe-widget").getByRole("link", { name: /Thin pancakes/ }),
  ).toBeVisible();

  await bea.close();
});

for (const scheme of ["light", "dark"] as const) {
  test(`the recipe editor, library and drafts by keyboard in the ${scheme} theme`, async ({
    page,
    baseURL,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await newAdult(page, baseURL, "Ward");
    await page.goto("/recipes/new");
    // Personal: no Home to choose.
    await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
    // Publishing without a name or an ingredient or step says what is missing.
    await page.getByTestId("recipe-publish").click();
    await expect(page.getByText("Fill this in.").first()).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await fillPancakes(page);
    // Rows move by keyboard.
    await page.getByRole("button", { name: "Move Step 2 up" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Step 1", { exact: true })).toHaveValue("Fry in a pan.");
    await page.getByTestId("recipe-publish").click();
    const publish = page.getByRole("dialog", { name: "Publish this recipe?" });
    await expect(publish).toContainText("Only you can see it, in your personal recipes.");
    await publish.getByRole("button", { name: "Publish to personal" }).click();
    await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("recipe-steps").getByRole("listitem").first()).toHaveText(
      "Fry in a pan.",
    );
    expect(await axeViolations(page)).toEqual([]);
    await page.goto("/recipes?q=flour");
    await expect(page.getByTestId("recipe-card")).toContainText("Pancakes");
    expect(await axeViolations(page)).toEqual([]);
    await page.goto("/recipes/drafts");
    await expect(page.getByText("No drafts")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });
}
