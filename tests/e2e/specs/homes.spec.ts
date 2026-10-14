import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";

import { registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, removeMember } from "../support/database";

// S09: Homes, roles and context switching. One adult is the Owner of their own Home and a Member
// of another person's Home; the Personal context stays separate from both. Each test makes its own
// accounts. Memberships in somebody else's Home are set up in the database, because invitations
// arrive with S10.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 800 },
});

const switcher = (page: Page, name: string) =>
  page.getByRole("button", { name: `Current context: ${name}` });

async function switchTo(page: Page, from: string, target: string) {
  await switcher(page, from).click();
  await page
    .getByRole("navigation", { name: "Switch context" })
    .getByRole("link", { name: new RegExp(`^${target}`) })
    .click();
}

/** Signs a new adult in and creates their own Home through the form; returns the account. */
async function adultWithHome(page: Page, baseURL: string | undefined, homeName: string) {
  const account = await registerConfirmed(baseURL ?? "");
  await signIn(page, account);
  await page.goto("/homes/new");
  await page.getByRole("textbox", { name: /Home name/ }).fill(homeName);
  await page.getByRole("button", { name: "Create Home" }).click();
  await page.waitForURL(/\/homes\/[0-9a-f-]{36}$/);
  return { account, homeId: page.url().split("/").pop() ?? "" };
}

test("an adult switches between a Home they own and a Home they are a Member of, and Personal stays separate", async ({
  page,
  baseURL,
}) => {
  const { account, homeId: ownHome } = await adultWithHome(page, baseURL, "Thuis");
  await expect(page.getByRole("heading", { level: 1, name: "Thuis" })).toBeVisible();
  await expect(page.getByTestId("home-role")).toHaveText(/Owner/);
  await expect(switcher(page, "Thuis")).toBeVisible();

  // Somebody else's Home, where this adult is a plain Member.
  const other = await registerConfirmed(baseURL ?? "");
  const otherHome = createHomeFor(other.email, "Buren");
  addMember(otherHome, account.email, "member");

  await page.reload();
  await switchTo(page, "Thuis", "Buren");
  await page.waitForURL(`**/homes/${otherHome}`);
  await expect(page.getByRole("heading", { level: 1, name: "Buren" })).toBeVisible();
  await expect(page.getByTestId("home-role")).toHaveText(/Member/);

  // A Member sees the settings but cannot change them.
  await page.goto(`/homes/${otherHome}/settings`);
  await expect(page.getByText(/your role in this Home doesn't let you change them/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);

  // Back to the Home they own: full settings.
  await switchTo(page, "Buren", "Thuis");
  await page.waitForURL(`**/homes/${ownHome}`);
  await expect(page.getByTestId("home-role")).toHaveText(/Owner/);
  await page.goto(`/homes/${ownHome}/settings`);
  await expect(page.getByRole("button", { name: "Save" })).toBeVisible();

  // The last Home is remembered: opening the app lands there again.
  await page.goto("/");
  await page.waitForURL(`**/homes/${ownHome}`);

  // Personal is its own context: no Home name or role, and it is remembered too.
  await switchTo(page, "Thuis", "Personal");
  await page.waitForURL((url) => url.pathname === "/");
  await expect(switcher(page, "Personal")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(/Thuis|Buren/);
  await page.goto("/");
  await expect(switcher(page, "Personal")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
});

test("a Home the person left, or never belonged to, is a neutral notice in Personal", async ({
  page,
  baseURL,
}) => {
  const { account } = await adultWithHome(page, baseURL, "Thuis");
  const other = await registerConfirmed(baseURL ?? "");
  const otherHome = createHomeFor(other.email, "Buren");
  addMember(otherHome, account.email, "member");

  await page.goto(`/homes/${otherHome}`);
  await expect(page.getByRole("heading", { level: 1, name: "Buren" })).toBeVisible();

  removeMember(otherHome, account.email);
  await page.reload();
  await expect(page.getByText("That Home isn't available to you.")).toBeVisible();
  await expect(switcher(page, "Personal")).toBeVisible();

  // The same answer for a Home that does not exist: nothing tells the two apart.
  await page.goto(`/homes/${randomUUID()}`);
  await expect(page.getByText("That Home isn't available to you.")).toBeVisible();
  await page.goto(`/homes/${randomUUID()}/settings`);
  await expect(page.getByText("That Home isn't available to you.")).toBeVisible();
  await expect(page.getByText("Buren")).toHaveCount(0);
});

test("the context switcher works with the keyboard and is accessible in both themes", async ({
  page,
  baseURL,
}) => {
  await adultWithHome(page, baseURL, "Thuis");
  const homeUrl = page.url();
  const button = switcher(page, "Thuis");
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: /^Personal/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute("aria-expanded", "false");

  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await button.click();
    expect(await axeViolations(page), `home page, open switcher, ${theme}`).toEqual([]);
    await page.keyboard.press("Escape");
    await page.goto("/homes/new");
    expect(await axeViolations(page), `create a Home, ${theme}`).toEqual([]);
    await page.goto(homeUrl);
  }
});

test("the same person can be in two Homes in two tabs", async ({ page, baseURL, context }) => {
  const { account, homeId: ownHome } = await adultWithHome(page, baseURL, "Thuis");
  const other = await registerConfirmed(baseURL ?? "");
  const otherHome = createHomeFor(other.email, "Buren");
  addMember(otherHome, account.email, "member");

  const second = await context.newPage();
  await second.goto(`/homes/${otherHome}`);
  await expect(second.getByRole("heading", { level: 1, name: "Buren" })).toBeVisible();
  // Each tab keeps its own Home: the URL is the context.
  await page.goto(`/homes/${ownHome}`);
  await expect(switcher(page, "Thuis")).toBeVisible();
  await expect(switcher(second, "Buren")).toBeVisible();
});

test.describe("refused saves", () => {
  // The browser logs the deliberate 403 and 404 answers.
  test.use({ allowedConsoleErrors: [/status of 40[34]/] });

  test("an Owner saves the Home's settings; a Member and an outsider are refused", async ({
    page,
    baseURL,
  }) => {
    const { account, homeId: ownHome } = await adultWithHome(page, baseURL, "Thuis");
    const other = await registerConfirmed(baseURL ?? "");
    const otherHome = createHomeFor(other.email, "Buren");
    addMember(otherHome, account.email, "member");

    // The Owner renames the Home and changes its timezone; both stick after a reload.
    await page.goto(`/homes/${ownHome}/settings`);
    await page.getByRole("textbox", { name: /Home name/ }).fill("Ons huis");
    await page.getByRole("combobox", { name: "Home timezone" }).selectOption("America/New_York");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Home settings saved.")).toBeVisible();
    await expect(switcher(page, "Ons huis")).toBeVisible();
    await page.reload();
    await expect(page.getByRole("textbox", { name: /Home name/ })).toHaveValue("Ons huis");
    await expect(page.getByRole("combobox", { name: "Home timezone" })).toHaveValue(
      "America/New_York",
    );

    // The same request for a Home where they are only a Member, and for a Home that is not theirs.
    const patch = (homeId: string) =>
      page.evaluate(async (id) => {
        const response = await fetch(`/api/v1/homes/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Gekaapt" }),
        });
        return response.status;
      }, homeId);
    expect(await patch(otherHome)).toBe(403);
    expect(await patch(randomUUID())).toBe(404);
    await page.goto(`/homes/${otherHome}`);
    await expect(page.getByRole("heading", { level: 1, name: "Buren" })).toBeVisible();
  });
});
