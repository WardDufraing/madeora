import type { Page, WebSocket } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, realtimeAvailable, test } from "../support/browser";
import { createHomeFor, setGlobalProfile } from "../support/database";

// S38 done-condition: switching accounts on a shared device clears every cache and subscription.
// Ann opens a live shopping list (a Supabase Realtime subscription and TanStack Query data), then
// switches to Ben through the account chooser. Every websocket Ann's page opened is closed, nothing
// of Ann's is shown or reachable for Ben, and the chooser shows names only. Then: switching back
// needs Ann's own sign-in, removing an account from the device, and temporary deactivation with
// reactivation.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
});

async function adult(baseURL: string | undefined, name: string, colour: string): Promise<Account> {
  const account = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(account.email, name, colour);
  return account;
}

async function createList(page: Page, base: string, name: string): Promise<void> {
  await page.goto(base);
  await page.getByTestId("new-shopping-list").click();
  await page.getByTestId("shopping-list-name").fill(name);
  await page.getByTestId("shopping-list-create").click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

test("switching accounts clears every cache and subscription", async ({ page, baseURL }) => {
  const ann = await adult(baseURL, "Ann", "#2563eb");
  const ben = await adult(baseURL, "Ben", "#16a34a");
  const homeId = createHomeFor(ann.email, "Ann's flat");

  const sockets: WebSocket[] = [];
  page.on("websocket", (socket) => sockets.push(socket));

  await signIn(page, ann);
  await createList(page, `/homes/${homeId}/shopping`, "Ann's private groceries");
  const annListUrl = page.url();
  if (realtimeAvailable) {
    await expect.poll(() => sockets.length, { timeout: 20_000 }).toBeGreaterThan(0);
  }
  const annSockets = [...sockets];

  // The chooser: Ann is remembered and active; only her name shows, no Home or list.
  await page.getByTestId("switch-account-link").click();
  await expect(page).toHaveURL(/\/accounts$/);
  const list = page.getByRole("list", { name: "Remembered accounts" });
  await expect(list.getByText("Ann", { exact: true })).toBeVisible();
  await expect(list.getByText("Signed in now")).toBeVisible();
  await expect(page.getByText("Ann's flat")).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);

  // Add Ben: Ann is signed out on this device first (a full page load).
  await page.getByTestId("add-account").click();
  await expect(page).toHaveURL(/\/sign-in\?status=switched/);
  for (const socket of annSockets) {
    await expect.poll(() => socket.isClosed(), { timeout: 10_000 }).toBe(true);
  }
  // Nothing of Ann's session survives in this tab's storage.
  const leftovers = await page.evaluate(() =>
    [...Object.keys(window.localStorage), ...Object.keys(window.sessionStorage)].filter((key) =>
      /^sb-.+-auth-token/.test(key),
    ),
  );
  expect(leftovers).toEqual([]);

  await signIn(page, ben, page.url());
  await expect(page.getByText("Ann's private groceries")).toHaveCount(0);
  await page.goto(annListUrl);
  await expect(page.getByText("Ann's private groceries")).toHaveCount(0);

  // Both are remembered now; switching back to Ann needs Ann's own sign-in.
  await page.goto("/accounts");
  await expect(list.getByText("Ben", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Switch to Ann" }).click();
  await expect(page).toHaveURL(/\/sign-in\?status=switched&account=/);
  await expect(page.getByText("Signing in to")).toBeVisible();
  await page.goto(annListUrl);
  await expect(page).toHaveURL(/\/sign-in/);
  await signIn(page, ann, page.url());
  await page.goto(annListUrl);
  await expect(
    page.getByRole("heading", { level: 1, name: "Ann's private groceries" }),
  ).toBeVisible();

  // Removing Ben from this device leaves Ben's account untouched.
  await page.goto("/accounts");
  await page.getByRole("button", { name: "Remove Ben from this device" }).click();
  await expect(list.getByText("Ben", { exact: true })).toHaveCount(0);
  await signIn(page, ben, "/sign-in");
  await expect(page).not.toHaveURL(/\/sign-in/);
});

test("deactivating and reactivating an account", async ({ page, baseURL }) => {
  const cleo = await adult(baseURL, "Cleo", "#9333ea");
  await signIn(page, cleo);
  await page.goto("/settings/security/deactivate");
  await expect(page.getByRole("heading", { level: 1, name: "Deactivate account" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByTestId("deactivate-understand").check();
  await page.getByRole("button", { name: "Deactivate my account" }).click();
  const confirm = page.getByRole("form", { name: "Confirm it's you to deactivate your account." });
  await confirm.getByLabel(/password/i).fill(cleo.password);
  await confirm.getByRole("button", { name: "Deactivate my account" }).click();
  await expect(page).toHaveURL(/\/sign-in\?status=deactivated/);

  // Signing in again leads only to reactivation.
  await signIn(page, cleo);
  await expect(page).toHaveURL(/\/reactivate$/);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/reactivate$/);
  await page.getByRole("button", { name: "Reactivate my account" }).click();
  await expect(page).toHaveURL(/\/settings\/activity\?/);
  await expect(page.getByText(/Welcome back/)).toBeVisible();
  await page.goto("/settings/security/activity");
  await expect(page.getByText("Account reactivated").first()).toBeVisible();
});
