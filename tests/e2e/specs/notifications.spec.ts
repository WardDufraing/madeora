import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, removeMember, sql } from "../support/database";

// S14: the notification centre and the notification settings. Notifications are written by the
// database (triggers); these tests create them the way a trigger does, with the delivery function,
// and then use the real pages as the person would. Each test makes its own account.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 800 },
});

async function newAdult(page: Page, baseURL: string | undefined) {
  const account = await registerConfirmed(baseURL ?? "");
  await signIn(page, account);
  return account;
}

/** Delivers one notification to `account` exactly as the database does; returns nothing. */
function notify(account: Account, homeId: string | null, kind: string, category = "security") {
  sql(
    `select private.notify_user(
       (select id from auth.users where email = :'email'),
       nullif(:'home', '')::uuid, :'category', :'kind', '{}', :'key');`,
    { email: account.email, home: homeId ?? "", category, kind, key: `e2e:${randomUUID()}` },
  );
}

test("the notification centre lists what happened, counts unread ones and marks them read", async ({
  page,
  baseURL,
}) => {
  const account = await newAdult(page, baseURL);
  const homeId = createHomeFor(account.email, "Thuis");
  notify(account, homeId, "recovery.owner_requested");

  await page.goto("/");
  await expect(page.getByTestId("notification-count")).toHaveText("1");
  await expect(page.getByRole("link", { name: "Notifications: 1 unread" })).toBeVisible();

  await page.getByTestId("notification-bell").click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
  const row = page.getByTestId("notification");
  await expect(row).toHaveText(/asked Madeora to review taking over ownership of .?Thuis/);
  await expect(row).toHaveText(/From .?Thuis/);
  await expect(row).toHaveAttribute("data-unread", "true");
  expect(await axeViolations(page)).toEqual([]);

  // Keyboard only.
  await row.getByRole("button", { name: /Mark as read/ }).focus();
  await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("data-unread", "false");
  await expect(page.getByTestId("notification-count")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("notification")).toHaveAttribute("data-unread", "false");
});

test("an empty notification centre says so, and Home notices disappear with the membership", async ({
  page,
  baseURL,
}) => {
  const account = await newAdult(page, baseURL);
  await page.goto("/notifications");
  await expect(page.getByTestId("notifications-empty")).toBeVisible();

  const other = await registerConfirmed(baseURL ?? "");
  const otherHome = createHomeFor(other.email, "Buren");
  addMember(otherHome, account.email, "member");
  notify(account, otherHome, "recovery.member_requested");
  await page.reload();
  await expect(page.getByTestId("notification")).toHaveText(/From .?Buren/);

  removeMember(otherHome, account.email);
  await page.reload();
  await expect(page.getByTestId("notifications-empty")).toBeVisible();
  await expect(page.getByTestId("notification-count")).toHaveCount(0);
});

test("defaults, a Home override and its reset, with a plain-language preview", async ({
  page,
  baseURL,
}) => {
  const account = await newAdult(page, baseURL);
  createHomeFor(account.email, "Thuis");
  await page.goto("/settings/notifications");
  await expect(
    page.getByRole("heading", { level: 1, name: "Notification settings" }),
  ).toBeVisible();
  await expect(page.getByText(/always on/)).toBeVisible();

  const defaults = page.getByRole("group", { name: "Your defaults" });
  const home = page.getByRole("group", { name: "Thuis" });
  await expect(defaults.getByTestId("notification-preview")).toContainText("in the app only");
  await expect(home.getByTestId("notification-status")).toHaveText("Inherited from your defaults");
  expect(await axeViolations(page)).toEqual([]);

  // Email on for the account: the Home inherits it.
  await defaults.getByRole("checkbox", { name: "By email" }).click();
  await expect(defaults.getByTestId("notification-preview")).toContainText(
    "in the app and by email",
  );
  await expect(home.getByTestId("notification-preview")).toContainText("in the app and by email");
  await expect(home.getByTestId("notification-status")).toHaveText("Inherited from your defaults");

  // The Home overrides it; the override survives a change of the account's default.
  await home.getByRole("checkbox", { name: "By email" }).click();
  await expect(home.getByTestId("notification-status")).toHaveText("Set for this Home");
  await expect(home.getByTestId("notification-preview")).toContainText("in the app only");
  await defaults.getByRole("checkbox", { name: "By email" }).click();
  await expect(defaults.getByTestId("notification-preview")).toContainText("in the app only");
  await expect(home.getByTestId("notification-status")).toHaveText("Set for this Home");
  await page.reload();
  await expect(home.getByTestId("notification-status")).toHaveText("Set for this Home");

  // Reset: back to inheriting.
  await home.getByRole("button", { name: "Use my defaults" }).click();
  await expect(home.getByTestId("notification-status")).toHaveText("Inherited from your defaults");
});

test("quiet hours are saved per scope, with their own zone", async ({ page, baseURL }) => {
  const account = await newAdult(page, baseURL);
  createHomeFor(account.email, "Thuis");
  await page.goto("/settings/notifications");
  const defaults = page.getByRole("group", { name: "Your defaults" });
  const home = page.getByRole("group", { name: "Thuis" });

  await expect(home.getByLabel("Time zone")).toHaveValue("Europe/Brussels");
  await defaults.getByRole("checkbox", { name: "Use quiet hours" }).click();
  await defaults.getByLabel("From").fill("21:30");
  await defaults.getByLabel("Until").fill("06:45");
  await defaults.getByRole("button", { name: "Save quiet hours" }).click();
  await expect(defaults.getByText("Saved.")).toBeVisible();

  await page.reload();
  await expect(defaults.getByLabel("From")).toHaveValue("21:30");
  await expect(defaults.getByLabel("Until")).toHaveValue("06:45");
  // The Home inherits them until it sets its own.
  await expect(home.getByTestId("notification-preview")).toContainText(
    "Quiet hours: 21:30 to 06:45",
  );
  await expect(home.getByRole("button", { name: "Use my default quiet hours" })).toHaveCount(0);

  await home.getByLabel("From").fill("23:00");
  await home.getByRole("button", { name: "Save quiet hours" }).click();
  await expect(home.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(home.getByTestId("notification-preview")).toContainText(
    "Quiet hours: 23:00 to 06:45",
  );
  await home.getByRole("button", { name: "Use my default quiet hours" }).click();
  await expect(home.getByTestId("notification-preview")).toContainText(
    "Quiet hours: 21:30 to 06:45",
  );

  // An empty window is refused before anything is sent.
  await defaults.getByLabel("Until").fill("21:30");
  await defaults.getByRole("button", { name: "Save quiet hours" }).click();
  await expect(defaults.getByText("Choose a start and an end that differ.")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});
