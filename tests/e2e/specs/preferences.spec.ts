import type { Browser, BrowserContext, Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";

// S07: the personal context with zero Homes, the starter dashboard shell and the account's global
// preferences. Each test makes its own account, because these tests change account settings that
// every page of that account follows (the shared test account must keep its defaults).
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
});

const desktop = { width: 1280, height: 800 };
test.use({ viewport: desktop });

async function newAdult(page: Page, baseURL: string | undefined): Promise<Account> {
  const account = await registerConfirmed(baseURL ?? "");
  await signIn(page, account);
  return account;
}

/** Another device: a separate browser context, signed in to the same account. */
async function otherDevice(
  browser: Browser,
  account: Account,
  options: { locale?: string; timezoneId?: string } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: desktop,
    ...options,
  });
  const page = await context.newPage();
  await signIn(page, account);
  return { context, page };
}

/** Today's date in `timeZone` as YYYY-MM-DD. */
function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
}

/**
 * The dashboard renders in `timeZone`, and its date is today there (either side of a midnight
 * during the test). The assertion retries, so a device's first visit, where the page refreshes
 * once the browser has reported its zone, is waited for instead of raced.
 */
async function expectDashboardDateIn(page: Page, timeZone: string) {
  const before = todayIn(timeZone);
  await page.goto("/");
  const today = page.getByTestId("today");
  await expect(today).toHaveAttribute("data-time-zone", timeZone);
  expect([before, todayIn(timeZone)]).toContain(await today.getAttribute("datetime"));
}

const saveIn = (page: Page, section: string) =>
  page.getByRole("region", { name: section }).getByRole("button", { name: "Save" });
const saveForm = (page: Page, form: string) =>
  page.getByRole("form", { name: form }).getByRole("button", { name: "Save" });

test("a new adult lands on the personal dashboard with zero Homes, without being blocked", async ({
  page,
  baseURL,
}) => {
  await newAdult(page, baseURL);
  expect(new URL(page.url()).pathname).toBe("/");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(main.getByText("Welcome to Madeora")).toBeVisible();
  await expect(page.getByRole("button", { name: "Current context: Personal" })).toBeVisible();
  await expect(main.getByTestId("dashboard-grid")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const homes = main.getByRole("region", { name: "Homes" });
  await homes.getByRole("link", { name: "Create a Home" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Create a Home" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /Home name/ })).toBeVisible();
  await expect(page).toHaveTitle("Create a Home · Madeora");
  await page.getByRole("link", { name: "Cancel" }).click();
  await homes.getByRole("link", { name: "Join a Home" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Join a Home" })).toBeVisible();

  // Skipping Home setup is fine: personal pages keep working.
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
});

test("the Home pages need an account", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/homes/new");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fhomes%2Fnew$/);
  await context.close();
});

test("the display name is saved on the account: after a reload and on another device", async ({
  page,
  browser,
  baseURL,
}) => {
  const account = await newAdult(page, baseURL);
  await page.goto("/settings");
  const field = page.getByRole("textbox", { name: "Display name" });
  await field.fill("  Sam Example  ");
  await saveIn(page, "Profile").click();
  await expect(page.getByRole("status").filter({ hasText: "Display name saved." })).toBeVisible();

  await page.reload();
  await expect(field).toHaveValue("Sam Example");
  await page.goto("/");
  await expect(page.getByText("Welcome, \u2068Sam Example\u2069")).toBeVisible();

  const other = await otherDevice(browser, account);
  await expect(other.page.getByText("Welcome, \u2068Sam Example\u2069")).toBeVisible();
  await other.context.close();

  // Emptying the field removes the name.
  await page.goto("/settings");
  await field.fill("");
  await saveIn(page, "Profile").click();
  await expect(page.getByRole("status").filter({ hasText: "Display name saved." })).toBeVisible();
  await page.goto("/");
  await expect(page.getByText("Welcome to Madeora")).toBeVisible();
});

test("the language is saved on the account and wins over each device's language", async ({
  page,
  browser,
  baseURL,
}) => {
  const account = await newAdult(page, baseURL);
  await page.goto("/settings");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByRole("radio", { name: "Nederlands" }).check();
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
  await expect(page.getByRole("heading", { level: 1, name: "Instellingen" })).toBeVisible();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
  await expect(page.getByRole("radio", { name: "Nederlands" })).toBeChecked();

  // Another device whose browser asks for English still gets the account's Dutch.
  const other = await otherDevice(browser, account, { locale: "en-US" });
  await expect(other.page.locator("html")).toHaveAttribute("lang", "nl");
  await expect(other.page.getByRole("navigation", { name: "Hoofdmenu" })).toBeVisible();
  await other.context.close();

  // This device also remembers it for its sign-in page after signing out.
  await page.getByRole("button", { name: "Afmelden" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
});

test("regional formats: Custom choices persist and apply; Automatic restores the detected ones", async ({
  page,
  browser,
  baseURL,
}) => {
  const account = await newAdult(page, baseURL);
  await page.goto("/settings");
  const region = page.getByRole("region", { name: "Language and region" });
  const preview = (name: string) => region.locator(`[data-preview="${name}"]`);
  // en-GB browser: day/month/year, 24-hour clock, Monday, 1,234.5, metric.
  await expect(region.getByRole("radio", { name: "Automatic", exact: true })).toBeChecked();
  await expect(preview("date")).toHaveText("31/12/2026");
  await expect(preview("time")).toHaveText("14:30");
  await expect(preview("week")).toHaveText("Mon Tue Wed Thu Fri Sat Sun");

  await region.getByRole("radio", { name: "Custom" }).check();
  await region.getByRole("combobox", { name: "Date" }).selectOption("ymd-dash");
  await region.getByRole("combobox", { name: "Time" }).selectOption("12h");
  await region.getByRole("combobox", { name: "First day of the week" }).selectOption("sunday");
  await region.getByRole("combobox", { name: "Numbers" }).selectOption("dot-comma");
  await region.getByRole("combobox", { name: "Units" }).selectOption("us-customary");
  // The preview follows each choice before anything is saved.
  await expect(preview("date")).toHaveText("2026-12-31");
  await expect(preview("time")).toHaveText(/^2:30\sPM$/u);
  await expect(preview("week")).toHaveText("Sun Mon Tue Wed Thu Fri Sat");
  await expect(preview("number")).toHaveText("1.234.567,89");
  await expect(preview("units")).toHaveText("3,4 mi · 70°F · 3,3 lb");
  await saveForm(page, "Regional formats").click();
  await expect(
    page.getByRole("status").filter({ hasText: "Regional formats saved." }),
  ).toBeVisible();

  await page.reload();
  await expect(region.getByRole("radio", { name: "Custom" })).toBeChecked();
  await expect(region.getByRole("combobox", { name: "Date" })).toHaveValue("ymd-dash");
  await expect(preview("date")).toHaveText("2026-12-31");
  await expect(preview("units")).toHaveText("3,4 mi · 70°F · 3,3 lb");
  await page.goto("/");
  await expect(page.getByTestId("today")).toHaveText(/ \d{4}-\d{2}-\d{2}$/);

  // The same formats on another device, even with a US browser.
  const other = await otherDevice(browser, account, { locale: "en-US" });
  await other.page.goto("/settings");
  await expect(other.page.locator('[data-preview="date"]')).toHaveText("2026-12-31");
  await expect(other.page.locator('[data-preview="units"]')).toHaveText("3,4 mi · 70°F · 3,3 lb");
  await other.context.close();

  // Automatic again: the detected en-GB formats come back.
  await page.goto("/settings");
  await region.getByRole("radio", { name: "Automatic", exact: true }).check();
  await saveForm(page, "Regional formats").click();
  await expect(
    page.getByRole("status").filter({ hasText: "Regional formats saved." }),
  ).toBeVisible();
  await page.reload();
  await expect(region.getByRole("radio", { name: "Automatic", exact: true })).toBeChecked();
  await expect(preview("date")).toHaveText("31/12/2026");
  await expect(preview("time")).toHaveText("14:30");
});

test.describe("timezone", () => {
  test.use({ timezoneId: "Asia/Tokyo" });

  test("Automatic follows each device; a chosen zone applies on every device until Automatic again", async ({
    page,
    browser,
    baseURL,
  }) => {
    const account = await newAdult(page, baseURL);
    await page.goto("/settings");
    const automatic = page.getByRole("radio", { name: /^Automatic: the timezone/ });
    await expect(automatic).toBeChecked();
    await expect(automatic).toHaveAccessibleDescription("This device reports Asia/Tokyo.");
    await expectDashboardDateIn(page, "Asia/Tokyo");

    // A second device elsewhere uses its own zone in Automatic mode.
    const other = await otherDevice(browser, account, { timezoneId: "America/Los_Angeles" });
    await expectDashboardDateIn(other.page, "America/Los_Angeles");

    await page.goto("/settings");
    await page.getByRole("radio", { name: "The same timezone on every device" }).check();
    await page
      .getByRole("combobox", { name: "Timezone to use" })
      .selectOption("Pacific/Kiritimati");
    await expect(page.locator('[data-preview="time-zone"]')).toContainText("Pacific/Kiritimati");
    await saveForm(page, "Timezone").click();
    await expect(page.getByRole("status").filter({ hasText: "Timezone saved." })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("combobox", { name: "Timezone to use" })).toHaveValue(
      "Pacific/Kiritimati",
    );
    await expectDashboardDateIn(page, "Pacific/Kiritimati");
    await expectDashboardDateIn(other.page, "Pacific/Kiritimati");

    // Back to Automatic: each device uses its own zone again.
    await page.goto("/settings");
    await page.getByRole("radio", { name: /^Automatic: the timezone/ }).check();
    await saveForm(page, "Timezone").click();
    await expect(page.getByRole("status").filter({ hasText: "Timezone saved." })).toBeVisible();
    await expectDashboardDateIn(page, "Asia/Tokyo");
    await expectDashboardDateIn(other.page, "America/Los_Angeles");
    await other.context.close();
  });
});

test("the preferences API refuses cross-site, signed-out and forged requests", async ({
  page,
  browser,
  baseURL,
}) => {
  await newAdult(page, baseURL);
  const url = "/api/v1/me/preferences";
  const origin = new URL(baseURL ?? "").origin;

  const crossSite = await page.request.patch(url, {
    headers: { origin: "https://evil.example", "content-type": "application/json" },
    data: { locale: "nl" },
  });
  expect(crossSite.status()).toBe(403);

  const form = await page.request.patch(url, {
    headers: { origin, "content-type": "text/plain" },
    data: '{"locale":"nl"}',
  });
  expect(form.status()).toBe(415);

  const forged = await page.request.patch(url, {
    headers: { origin },
    data: { locale: "nl", user_id: "10000000-0000-4000-8000-000000000002" },
  });
  expect(forged.status()).toBe(400);

  const allowed = await page.request.patch(url, {
    headers: { origin },
    data: { weekStart: "sunday" },
  });
  expect(allowed.status()).toBe(200);
  expect(allowed.headers()["cache-control"]).toContain("no-store");
  expect(
    ((await allowed.json()) as { preferences: { weekStart: string } }).preferences.weekStart,
  ).toBe("sunday");
  // Nothing above changed the language.
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  const signedOut = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const anonymous = await signedOut.request.patch(`${origin}${url}`, {
    headers: { origin },
    data: { locale: "nl" },
  });
  expect(anonymous.status()).toBe(401);
  await signedOut.close();
});

for (const theme of ["light", "dark"] as const) {
  test(`dashboard and every settings form have no axe violations (${theme}, Custom and chosen zone open)`, async ({
    page,
    baseURL,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await newAdult(page, baseURL);
    expect(await axeViolations(page)).toEqual([]);
    await page.goto("/settings");
    await page.getByRole("radio", { name: "Custom" }).check();
    await page.getByRole("radio", { name: "The same timezone on every device" }).check();
    await expect(page.getByRole("combobox", { name: "Timezone to use" })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });
}
