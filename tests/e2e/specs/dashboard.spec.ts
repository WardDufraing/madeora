import type { Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, removeMember, sql } from "../support/database";

// S17: the dashboard engine. Personal and Home dashboards, edit mode with pointer-free (keyboard)
// arranging, templates and the server-side editing rules, against the real database. Each test
// makes its own accounts.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
  // The browser logs the deliberate refusals (forged saves).
  allowedConsoleErrors: [/status of (403|404|409)/],
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

async function select(page: Page, name: string | RegExp) {
  await page
    .getByRole("button", { name: typeof name === "string" ? `Arrange ${name}` : name })
    .click();
  return page.getByTestId("dashboard-selected");
}

function storedLayout(email: string): { widgets: { type: string; hidden: boolean }[] } | null {
  const raw = sql(
    `select layout from private.dashboard_layouts
     where owner_user_id = (select id from auth.users where email = :'email');`,
    { email },
  );
  return raw ? (JSON.parse(raw) as { widgets: { type: string; hidden: boolean }[] }) : null;
}

/** A same-origin JSON request with the page's own session, like a hand-made fetch would send. */
async function forged(
  page: Page,
  baseURL: string | undefined,
  path: string,
  method: string,
  data: unknown,
) {
  return page.request.fetch(path, {
    method,
    data,
    headers: { origin: baseURL ?? "", "content-type": "application/json" },
  });
}

test("a new adult gets a starter dashboard, customizes it by keyboard, and it persists", async ({
  page,
  baseURL,
}) => {
  const account = await newAdult(page, baseURL);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  // The starter layout, with truthful empty states and nothing invented.
  await expect(widget(page, "Welcome").getByText("Welcome to Madeora")).toBeVisible();
  await expect(
    widget(page, "Quick actions").getByRole("link", { name: "Create a Home" }),
  ).toBeVisible();
  await expect(widget(page, "Notifications").getByText("No notifications")).toBeVisible();
  await expect(page.getByRole("region", { name: "Homes" })).toBeVisible();
  expect(storedLayout(account.email)).toBeNull();

  await customize(page);
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    expect(await axeViolations(page), `edit mode, ${theme}`).toEqual([]);
  }

  // Keyboard only: move Notifications up, make it narrower, hide Quick actions, remove Welcome.
  // (Which screen-size layout this edits depends on the dashboard's width next to the sidebar.)
  const notifications = page.getByRole("button", { name: "Arrange Notifications" });
  await notifications.focus();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("status").filter({ hasText: /^Notifications: row/ })).toBeAttached();
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(page.getByRole("status").filter({ hasText: /5 wide/ })).toBeAttached();
  await expect(notifications).toBeFocused();

  let panel = await select(page, "Quick actions");
  await panel.getByRole("button", { name: "Hide" }).click();
  panel = await select(page, "Welcome");
  await panel.getByRole("button", { name: "Remove" }).click();
  await page
    .getByTestId("dashboard-catalogue")
    .getByRole("button", { name: "Add Welcome" })
    .click();
  panel = page.getByTestId("dashboard-selected");
  await panel.getByLabel("Show today's date").uncheck();
  await save(page);

  await page.reload();
  await expect(widget(page, "Quick actions")).toHaveCount(0);
  await expect(widget(page, "Welcome").getByTestId("today")).toHaveCount(0);
  const stored = storedLayout(account.email);
  expect(stored?.widgets.map((w) => [w.type, w.hidden])).toEqual([
    ["quick-actions", true],
    ["notifications", false],
    ["tasks", false],
    ["welcome", false],
  ]);

  // Remove everything: an honest empty dashboard.
  await customize(page);
  for (const name of ["Notifications", "Welcome", "Quick actions", "Personal tasks"]) {
    panel = await select(page, name);
    await panel.getByRole("button", { name: "Remove" }).click();
  }
  await save(page);
  await expect(page.getByText("No widgets to show")).toBeVisible();

  // Reset to the starter layout, then undo it once.
  await customize(page);
  await page.getByRole("button", { name: "Reset to starter layout" }).click();
  const dialog = page.getByRole("dialog", { name: "Reset to the starter layout?" });
  await expect(dialog).toContainText("Welcome, Quick actions, Notifications, Tasks");
  await dialog.getByRole("button", { name: "Reset layout" }).click();
  await expect(page.getByText("The dashboard is back to the starter layout.")).toBeVisible();
  await expect(widget(page, "Welcome")).toBeVisible();
  await page.getByTestId("dashboard-undo").click();
  await expect(page.getByText("The last change was undone.")).toBeVisible();
  await expect(page.getByText("No widgets to show")).toBeVisible();

  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    expect(await axeViolations(page), `dashboard, ${theme}`).toEqual([]);
  }
});

test("a Home dashboard is edited by its Owner and granted Administrators only", async ({
  page,
  baseURL,
  browser,
}) => {
  const owner = await newAdult(page, baseURL);
  const homeId = createHomeFor(owner.email, "Thuis");
  const member = await registerConfirmed(baseURL ?? "");
  const admin = await registerConfirmed(baseURL ?? "");
  addMember(homeId, member.email, "member");
  addMember(homeId, admin.email, "administrator");

  await page.goto(`/homes/${homeId}`);
  await expect(widget(page, "Welcome").getByText(/Welcome to .*Thuis/)).toBeVisible();
  await customize(page);
  const panel = await select(page, "Quick actions");
  await panel.getByRole("button", { name: "Hide" }).click();
  await save(page);
  await expect(widget(page, "Quick actions")).toHaveCount(0);

  // A plain Member sees the shared layout but cannot change it, not even with a hand-made request.
  const memberContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const memberPage = await memberContext.newPage();
  await signIn(memberPage, member);
  await memberPage.goto(`/homes/${homeId}`);
  await expect(widget(memberPage, "Home members")).toBeVisible();
  await expect(widget(memberPage, "Quick actions")).toHaveCount(0);
  await expect(memberPage.getByTestId("dashboard-customize")).toHaveCount(0);
  const refused = await forged(memberPage, baseURL, "/api/v1/dashboard/reset", "POST", {
    target: { kind: "home", homeId },
    expectedRevision: 1,
  });
  expect(refused.status()).toBe(403);
  await memberContext.close();

  // An Administrator needs the right; with it, Customize appears and saving works.
  const adminContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const adminPage = await adminContext.newPage();
  await signIn(adminPage, admin);
  await adminPage.goto(`/homes/${homeId}`);
  await expect(widget(adminPage, "Welcome")).toBeVisible();
  await expect(adminPage.getByTestId("dashboard-customize")).toHaveCount(0);
  sql(
    `insert into private.home_admin_capabilities (home_id, user_id, capability)
     select :'home'::uuid, id, 'manageHomeDashboard' from auth.users where email = :'email';`,
    { home: homeId, email: admin.email },
  );
  await adminPage.reload();
  await customize(adminPage);
  const adminPanel = await select(adminPage, "Quick actions");
  await adminPanel.getByRole("button", { name: "Show" }).click();
  await save(adminPage);
  await expect(widget(adminPage, "Quick actions")).toBeVisible();
  await adminContext.close();
});

test("a selected Home widget on the personal dashboard is labelled, and unavailable after leaving", async ({
  page,
  baseURL,
}) => {
  const account = await newAdult(page, baseURL);
  const other = await registerConfirmed(baseURL ?? "");
  const homeId = createHomeFor(other.email, "Buren");
  addMember(homeId, account.email, "member");

  await page.goto("/?context=personal");
  await customize(page);
  const catalogue = page.getByTestId("dashboard-catalogue");
  await expect(catalogue.getByText(/Home members · .*Buren/)).toBeVisible();
  await catalogue.getByRole("button", { name: "Add Home members" }).click();
  await save(page);
  const homeWidget = widget(page, /Home members · .*Buren/);
  await expect(homeWidget.getByText(/\(you\)/)).toBeVisible();

  // Switching to the Home and back changes nothing about it.
  await page.goto(`/homes/${homeId}`);
  await expect(page.getByRole("heading", { level: 1, name: /Buren/ })).toBeVisible();
  await page.goto("/?context=personal");
  await expect(widget(page, /Home members · .*Buren/)).toBeVisible();

  // After leaving, the widget stays until removed, but shows nothing of the Home.
  removeMember(homeId, account.email);
  await page.reload();
  const unavailable = widget(page, "Widget unavailable");
  await expect(unavailable).toBeVisible();
  await expect(unavailable).not.toContainText("Buren");
  await expect(page.getByTestId("dashboard-grid")).not.toContainText("Buren");
  // Other edits may keep it, so the person removes it when they like.
  await customize(page);
  let panel = await select(page, "Welcome");
  await panel.getByRole("button", { name: "Hide" }).click();
  await save(page);
  await expect(widget(page, "Widget unavailable")).toBeVisible();
  await customize(page);
  panel = await select(page, "Widget unavailable");
  await panel.getByRole("button", { name: "Remove" }).click();
  await save(page);
  await expect(widget(page, "Widget unavailable")).toHaveCount(0);
});

test("templates are shared into a Home by kind and applied by the right people", async ({
  page,
  baseURL,
  browser,
}) => {
  const sharer = await newAdult(page, baseURL);
  const homeId = createHomeFor(sharer.email, "Thuis");
  const member = await registerConfirmed(baseURL ?? "");
  addMember(homeId, member.email, "member");

  // A personal template, shared into the Home.
  await page.goto("/?context=personal");
  await customize(page);
  const panel = await select(page, "Quick actions");
  await panel.getByRole("button", { name: "Remove" }).click();
  await save(page);
  await customize(page);
  await page.getByLabel("Template name").fill("Calm mornings");
  await page.getByRole("button", { name: "Save as template" }).click();
  await expect(page.getByText(/Saved as template/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  // A Home template from the Home dashboard, shared into the same Home.
  await page.goto(`/homes/${homeId}`);
  await customize(page);
  await page.getByLabel("Template name").fill("Family board");
  await page.getByRole("button", { name: "Save as template" }).click();
  await expect(page.getByText(/Saved as template/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.goto("/settings");
  await page.getByTestId("dashboard-templates-link").click();
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard templates" })).toBeVisible();
  for (const name of ["Calm mornings", "Family board"]) {
    const card = page.getByRole("article", { name });
    await card.getByRole("checkbox", { name: "Thuis" }).check();
    await expect(page.getByText(/Shared into .*Thuis.*\./)).toBeVisible();
  }
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    expect(await axeViolations(page), `templates page, ${theme}`).toEqual([]);
  }

  // The member applies the personal template to their own dashboard.
  const memberContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const memberPage = await memberContext.newPage();
  await signIn(memberPage, member);
  await memberPage.goto("/?context=personal");
  await customize(memberPage);
  // Edit mode loads the templates itself; wait for the shared one to arrive.
  const picker = memberPage.getByLabel("Template", { exact: true });
  await expect(
    picker.getByRole("option", { name: "\u2068Calm mornings\u2069 (shared)" }),
  ).toBeAttached();
  await picker.selectOption({ label: "\u2068Calm mornings\u2069 (shared)" });
  await expect(memberPage.getByText("Contains: Welcome, Notifications")).toBeVisible();
  await memberPage.getByTestId("dashboard-apply-template").click();
  await memberPage.getByRole("dialog").getByRole("button", { name: "Apply template" }).click();
  await expect(memberPage.getByText("Template applied.")).toBeVisible();
  await expect(widget(memberPage, "Quick actions")).toHaveCount(0);
  await expect(widget(memberPage, "Notifications")).toBeVisible();

  // The Home template cannot be applied by a plain Member.
  const templateId = sql(`select id from private.dashboard_templates where name = 'Family board';`);
  const refused = await forged(memberPage, baseURL, "/api/v1/dashboard/apply-template", "POST", {
    target: { kind: "home", homeId },
    expectedRevision: 0,
    template: { id: templateId },
  });
  expect(refused.status()).toBe(403);
  await memberContext.close();
});
