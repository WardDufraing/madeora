import type { Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor } from "../support/database";

// UX2c: layout presets (templates with preview and duplicate; redesign decision 31) and the
// 10-version dashboard history with preview and restore (decision 32), against the real database.
// Each test makes its own accounts.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
  // The browser logs the deliberate refusals (a Member asking for the history).
  allowedConsoleErrors: [/status of (403|404)/],
});

async function newAdult(page: Page, baseURL: string | undefined): Promise<Account> {
  const account = await registerConfirmed(baseURL ?? "");
  await signIn(page, account);
  return account;
}

const widget = (page: Page, name: string | RegExp) =>
  page.getByTestId("dashboard-widget").filter({ has: page.getByRole("heading", { name }) });

async function customize(page: Page) {
  await page.getByTestId("dashboard-customize").click();
  await expect(page.getByTestId("dashboard-editor")).toBeVisible();
}

async function save(page: Page) {
  await page.getByTestId("dashboard-save").click();
  await expect(page.getByText("Dashboard saved.")).toBeVisible();
  await expect(page.getByTestId("dashboard-editor")).toHaveCount(0);
}

async function removeWidget(page: Page, name: string) {
  await page.getByRole("button", { name: `Arrange ${name}` }).click();
  await page.getByTestId("dashboard-selected").getByRole("button", { name: "Remove" }).click();
}

test("the dashboard history previews and restores an earlier version, which can be undone", async ({
  page,
  baseURL,
}) => {
  await newAdult(page, baseURL);
  await customize(page);
  await removeWidget(page, "Welcome");
  await save(page);
  await customize(page);
  await removeWidget(page, "Notifications");
  await save(page);
  await expect(widget(page, "Notifications")).toHaveCount(0);

  await customize(page);
  await page.getByTestId("dashboard-history-open").click();
  const history = page.getByRole("dialog", { name: "Version history" });
  const versions = history.getByTestId("dashboard-history-version");
  await expect(versions).toHaveCount(2);
  await expect(versions.first()).toContainText("Current layout");
  await expect(versions.first()).toContainText("Removed: Notifications");
  await expect(versions.first().getByRole("button", { name: "Restore" })).toHaveCount(0);

  await versions.nth(1).getByTestId("dashboard-history-preview").click();
  await expect(versions.nth(1).getByTestId("layout-preview")).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    expect(await axeViolations(page), `history, ${theme}`).toEqual([]);
  }

  await versions.nth(1).getByTestId("dashboard-history-restore").click();
  const confirm = page.getByRole("dialog", { name: "Restore this version?" });
  await expect(confirm).toContainText("stays in the version history");
  await confirm.getByTestId("dashboard-history-restore-confirm").click();
  await expect(page.getByText(/The earlier version was restored/)).toBeVisible();
  await expect(page.getByTestId("dashboard-editor")).toHaveCount(0);
  await expect(widget(page, "Notifications")).toBeVisible();
  await expect(widget(page, "Welcome")).toHaveCount(0);

  // The replaced layout is still in the history, and Undo brings it back once.
  await page.getByTestId("dashboard-undo").click();
  await expect(page.getByText("The last change was undone.")).toBeVisible();
  await expect(widget(page, "Notifications")).toHaveCount(0);
  await customize(page);
  await page.getByTestId("dashboard-history-open").click();
  await expect(
    page.getByRole("dialog", { name: "Version history" }).getByTestId("dashboard-history-version"),
  ).toHaveCount(4);
});

test("a Home's history is for its dashboard editors only", async ({ page, baseURL, browser }) => {
  const owner = await newAdult(page, baseURL);
  const homeId = createHomeFor(owner.email, "Thuis");
  const member = await registerConfirmed(baseURL ?? "");
  addMember(homeId, member.email, "member");

  await page.goto(`/homes/${homeId}`);
  await customize(page);
  await removeWidget(page, "Welcome");
  await save(page);
  const ownerHistory = await page.request.get(`/api/v1/dashboard/history?homeId=${homeId}`);
  expect(ownerHistory.status()).toBe(200);
  const body = (await ownerHistory.json()) as { versions: { id: string }[] };
  expect(body.versions).toHaveLength(1);

  const memberContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const memberPage = await memberContext.newPage();
  await signIn(memberPage, member);
  const refused = await memberPage.request.get(`/api/v1/dashboard/history?homeId=${homeId}`);
  expect(refused.status()).toBe(403);
  const restore = await memberPage.request.fetch("/api/v1/dashboard/history/restore", {
    method: "POST",
    data: {
      target: { kind: "home", homeId },
      versionId: body.versions[0]?.id,
      expectedRevision: 1,
    },
    headers: { origin: baseURL ?? "", "content-type": "application/json" },
  });
  expect(restore.status()).toBe(403);
  // Their own personal history never answers for the Home's versions either.
  const personal = await memberPage.request.fetch("/api/v1/dashboard/history/restore", {
    method: "POST",
    data: { target: { kind: "personal" }, versionId: body.versions[0]?.id, expectedRevision: 1 },
    headers: { origin: baseURL ?? "", "content-type": "application/json" },
  });
  expect(personal.status()).toBe(404);
  await memberContext.close();
});

test("a template is previewed before applying, and duplicated under a free name", async ({
  page,
  baseURL,
}) => {
  await newAdult(page, baseURL);
  await customize(page);
  await page.getByLabel("Template name").fill("Mornings");
  await page.getByRole("button", { name: "Save as template" }).click();
  await expect(page.getByText(/Saved as template/)).toBeVisible();

  // The same name again is refused, without a request.
  await page.getByLabel("Template name").fill("mornings");
  await page.getByRole("button", { name: "Save as template" }).click();
  await expect(
    page.getByText("You already have a template with this name. Choose another name."),
  ).toBeVisible();

  await page.getByTestId("dashboard-apply-template").click();
  const apply = page.getByRole("dialog");
  await expect(apply.getByTestId("layout-preview")).toBeVisible();
  await apply.getByRole("button", { name: "Cancel" }).click();

  await page.goto("/settings/dashboard-templates");
  const mornings = page.getByRole("article", { name: "Mornings", exact: true });
  await mornings.getByTestId("template-preview").click();
  await expect(mornings.getByTestId("layout-preview")).toBeVisible();
  await mornings.getByTestId("template-duplicate").click();
  await expect(page.getByText(/Copy saved as/)).toBeVisible();
  await expect(page.getByRole("article", { name: "Mornings (copy)" })).toBeVisible();
  await mornings.getByTestId("template-duplicate").click();
  await expect(page.getByRole("article", { name: "Mornings (copy 2)" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});
