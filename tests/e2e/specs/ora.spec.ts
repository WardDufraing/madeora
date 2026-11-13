import { registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { createHomeFor } from "../support/database";

// S45: the Ora shell. The persistent button, the bubble (desktop) and bottom sheet (phone), the
// tools the server offers for exactly this person and place, and the settings that hide Ora. Each
// test makes its own account.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 800 },
});

const launcherName = "Open Ora, your Madeora helper";

test("Ora opens from the button, offers only what the person may use, and closes with Escape", async ({
  page,
  baseURL,
}) => {
  const account = await registerConfirmed(baseURL ?? "");
  const homeId = createHomeFor(account.email, "Thuis");
  await signIn(page, account);

  // Personal space: the personal pages only, no Home pages.
  await page.goto("/?context=personal");
  const launcher = page.getByTestId("ora-launcher");
  await expect(launcher).toBeVisible();
  await launcher.click();
  const surface = page.getByRole("dialog", { name: "Ora" });
  await expect(surface).toBeVisible();
  await expect(surface).toBeFocused();
  await expect(surface.getByRole("button", { name: "Open tasks" })).toBeVisible();
  await expect(surface.getByRole("button", { name: "Open chores" })).toHaveCount(0);
  await expect(surface.getByTestId("ora-context")).toHaveText("Helping in Personal");
  expect(await axeViolations(page)).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(surface).toBeHidden();
  await expect(launcher).toBeFocused();

  // Quick actions open the page and leave the page behind it in charge.
  await launcher.click();
  await surface.getByRole("button", { name: "Open tasks" }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(surface).toBeHidden();

  // A Home: its pages, and the management pages because this person owns it.
  await page.goto(`/homes/${homeId}`);
  await page.getByTestId("ora-launcher").click();
  await expect(surface.getByTestId("ora-context")).toHaveText("Helping in Thuis");
  await expect(surface.getByRole("button", { name: "Open chores" })).toBeVisible();
  await surface.getByRole("button", { name: "Browse all actions" }).click();
  await expect(surface.getByRole("button", { name: "Open Home settings" })).toBeVisible();
  await surface.getByRole("button", { name: "Open Home settings" }).click();
  await expect(page).toHaveURL(new RegExp(`/homes/${homeId}/settings$`));
});

test("Ora becomes a bottom sheet on a phone", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const account = await registerConfirmed(baseURL ?? "");
  await signIn(page, account);
  await page.goto("/?context=personal");
  await page.getByRole("button", { name: launcherName }).click();
  const surface = page.getByRole("dialog", { name: "Ora" });
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(388);
  // Sits at the bottom edge of the screen.
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeGreaterThanOrEqual(840);
  await expect(page.getByRole("button", { name: "Show Ora larger" })).toBeVisible();
  await page.getByRole("button", { name: "Show Ora larger" }).click();
  await expect(page.getByRole("button", { name: "Show Ora smaller" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test("the introduction appears once and is not repeated after Skip", async ({ page, baseURL }) => {
  const account = await registerConfirmed(baseURL ?? "");
  await signIn(page, account);
  await page.goto("/?context=personal");
  await page.getByTestId("ora-launcher").click();
  const intro = page.getByTestId("ora-intro");
  await expect(intro).toBeVisible();
  await intro.getByRole("button", { name: "Skip" }).click();
  await expect(intro).toBeHidden();
  await page.reload();
  await page.getByTestId("ora-launcher").click();
  await expect(page.getByRole("button", { name: "Open tasks" })).toBeVisible();
  await expect(page.getByTestId("ora-intro")).toHaveCount(0);
});

test("hiding Ora in settings removes it everywhere for this person, and it can come back", async ({
  page,
  baseURL,
}) => {
  const account = await registerConfirmed(baseURL ?? "");
  await signIn(page, account);
  await page.goto("/settings/ora");
  await expect(page.getByTestId("ora-launcher")).toBeVisible();

  await page.getByRole("switch", { name: "Ora is shown" }).uncheck();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByTestId("ora-launcher")).toHaveCount(0);
  await page.goto("/?context=personal");
  await expect(page.getByTestId("ora-launcher")).toHaveCount(0);
  // The rest of Madeora is untouched.
  await expect(page.getByRole("main")).toBeVisible();

  await page.goto("/settings/ora");
  await page.getByRole("switch", { name: "Ora is hidden and disabled" }).check();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByTestId("ora-launcher")).toBeVisible();
});

test("the colour is chosen per place and remembered, Heather by default", async ({
  page,
  baseURL,
}) => {
  const account = await registerConfirmed(baseURL ?? "");
  const homeId = createHomeFor(account.email, "Thuis");
  await signIn(page, account);
  await page.goto("/settings/ora");
  const home = page.getByRole("group", { name: "Thuis" });
  const personal = page.getByRole("group", { name: "Personal" });
  await expect(home.getByRole("radio", { name: /Heather/ })).toBeChecked();

  await home.getByText("Olive").click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(home.getByRole("radio", { name: /Olive/ })).toBeChecked();
  await expect(personal.getByRole("radio", { name: /Heather/ })).toBeChecked();

  // Ora itself uses the Home's colour inside that Home and Personal's outside it.
  await page.goto(`/homes/${homeId}`);
  await expect(page.getByTestId("ora-launcher").locator(".ora-char")).toHaveAttribute(
    "data-palette",
    "olive",
  );
  await page.goto("/?context=personal");
  await expect(page.getByTestId("ora-launcher").locator(".ora-char")).toHaveAttribute(
    "data-palette",
    "heather",
  );
});
