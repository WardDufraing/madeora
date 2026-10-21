import type { Browser, Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile } from "../support/database";

// S19c: task attachments, the calendar and the tasks widget. Files go to the local S3 stand-in
// that Playwright starts and are checked by the real finalize step; every view of a file is
// authorized by the real database. Each test makes its own accounts.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
  // The browser logs the deliberate refusals (a stranger's view of a file).
  allowedConsoleErrors: [/status of (403|404)/],
});

// A tiny real PNG (one pixel) and a minimal PDF.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
const CONTENT_PATH = /\/api\/v1\/files\/([0-9a-f-]{36})\/content/;

/** Today in the browser's (and so the Personal space's) timezone. */
function londonToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
}

async function newAdult(page: Page, baseURL: string | undefined, name: string): Promise<Account> {
  const account = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(account.email, name, "#2563eb");
  await signIn(page, account);
  return account;
}

async function otherAdult(
  browser: Browser,
  baseURL: string | undefined,
  name: string,
): Promise<{ page: Page; account: Account; close: () => Promise<void> }> {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    locale: "en-GB",
    timezoneId: "Europe/London",
  });
  const page = await context.newPage();
  const account = await newAdult(page, baseURL, name);
  return { page, account, close: () => context.close() };
}

async function createList(page: Page, base: string, name: string): Promise<void> {
  await page.goto(`${base}/manage`);
  await page.getByTestId("list-new").fill(name);
  await page.getByRole("button", { name: "Create list" }).click();
  await expect(page.getByTestId("manage-list").filter({ hasText: name })).toBeVisible();
}

async function addTask(
  page: Page,
  title: string,
  extra: (page: Page) => Promise<void> = async () => {},
) {
  const open = page.getByTestId("new-task-open");
  const form = page.getByTestId("new-task-form");
  await expect(open.or(form)).toBeVisible();
  if (await open.isVisible()) await open.click();
  await page.getByLabel("Title").fill(title);
  await extra(page);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByTestId("task-row").filter({ hasText: title })).toBeVisible();
}

async function attach(page: Page, name: string, mimeType: string, buffer: Buffer): Promise<void> {
  await page.getByTestId("attachment-input").setInputFiles({ name, mimeType, buffer });
  await expect(page.getByTestId("task-attachment").filter({ hasText: name })).toBeVisible();
}

async function fileIdOf(page: Page, name: string): Promise<string> {
  const href = await page
    .getByTestId("task-attachment")
    .filter({ hasText: name })
    .getByRole("link", { name: `Download ${name}` })
    .getAttribute("href");
  const id = CONTENT_PATH.exec(href ?? "")?.[1];
  if (!id) throw new Error(`no download link for ${name}: ${String(href)}`);
  return id;
}

function view(page: Page, fileId: string, download = false) {
  return page.request.get(`/api/v1/files/${fileId}/content${download ? "?download=1" : ""}`, {
    maxRedirects: 0,
  });
}

test("Home task attachments: add, preview, download, refuse strangers, remove and restore", async ({
  page,
  browser,
  baseURL,
}) => {
  test.slow();
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  const bea = await otherAdult(browser, baseURL, "Bea");
  addMember(homeId, bea.account.email, "member");
  const stranger = await otherAdult(browser, baseURL, "Cleo");
  const base = `/homes/${homeId}/tasks`;

  await createList(page, base, "Paperwork");
  await page.goto(base);
  await addTask(page, "Renew the lease");
  await page
    .getByTestId("task-row")
    .filter({ hasText: "Renew the lease" })
    .getByRole("link")
    .click();
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
  const taskUrl = page.url();
  await expect(page.getByTestId("attachment-count")).toHaveText("0 of 10");

  // A photo and a PDF: the photo shows a preview that really loads from storage.
  await attach(page, "receipt.png", "image/png", PNG);
  await attach(page, "Lease 2026.pdf", "application/pdf", PDF);
  await expect(page.getByTestId("attachment-count")).toHaveText("2 of 10");
  const preview = page.getByRole("img", { name: "Preview of receipt.png" });
  await expect(preview).toHaveJSProperty("complete", true);
  expect(await preview.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1);
  const pdfRow = page.getByTestId("task-attachment").filter({ hasText: "Lease 2026.pdf" });
  await expect(pdfRow).toContainText("PDF");
  await expect(pdfRow).toContainText("Added by You");
  await expect(pdfRow.getByRole("link", { name: "Open Lease 2026.pdf" })).toHaveAttribute(
    "target",
    "_blank",
  );

  // Opening shows the PDF in the browser; downloading names the file.
  const pdfId = await fileIdOf(page, "Lease 2026.pdf");
  const opened = await view(page, pdfId);
  expect(opened.status()).toBe(302);
  expect(decodeURIComponent(opened.headers().location ?? "")).toContain("inline");
  const downloaded = await view(page, pdfId, true);
  expect(downloaded.status()).toBe(302);
  const location = decodeURIComponent(downloaded.headers().location ?? "");
  expect(location).toContain("attachment");
  expect(location).toContain("Lease 2026.pdf");

  // A Home member sees the files; a stranger gets nothing, not even that they exist.
  await bea.page.goto(taskUrl);
  await expect(bea.page.getByTestId("task-attachment")).toHaveCount(2);
  expect((await view(bea.page, pdfId)).status()).toBe(302);
  expect((await view(stranger.page, pdfId)).status()).toBe(404);
  const taskId = taskUrl.split("/").pop() ?? "";
  const listed = await stranger.page.request.get(`/api/v1/tasks/${taskId}/attachments`);
  expect(listed.status()).toBe(404);
  await stranger.page.goto(taskUrl);
  await expect(stranger.page.getByTestId("task-attachment")).toHaveCount(0);

  // Removing moves the file to the trash; the link stops working until it is restored.
  await pdfRow.getByRole("button", { name: "Remove Lease 2026.pdf" }).click();
  await expect(page.getByRole("dialog", { name: /Remove .*Lease 2026\.pdf/ })).toContainText(
    "trash for 7 days",
  );
  await page.getByTestId("attachment-remove-confirm").click();
  await expect(page.getByTestId("task-attachment")).toHaveCount(1);
  expect((await view(bea.page, pdfId)).status()).toBe(404);

  await page.goto(`/homes/${homeId}/trash`);
  const entry = page.getByTestId("trash-entry").filter({ hasText: "Task attachment" });
  await expect(entry).toContainText("Lease 2026.pdf");
  await entry.getByRole("checkbox").check();
  await page.getByTestId("trash-restore").click();
  await expect(page.getByTestId("trash-result")).toContainText("1 item restored.");
  await page.goto(taskUrl);
  await expect(page.getByTestId("task-attachment")).toHaveCount(2);
  expect((await view(bea.page, pdfId)).status()).toBe(302);
  expect(await axeViolations(page)).toEqual([]);

  await bea.close();
  await stranger.close();
});

test("tasks widget and calendar: filter, complete from the widget and from a day", async ({
  page,
  baseURL,
}) => {
  test.slow();
  await newAdult(page, baseURL, "Ward");
  await createList(page, "/tasks", "House");
  await page.goto("/tasks");
  const today = londonToday();
  await addTask(page, "Call the plumber", async (p) => {
    await p.getByLabel("Priority").selectOption("high");
    await p.getByLabel("Due date").fill(today);
  });
  await addTask(page, "Sort the post", async (p) => {
    await p.getByLabel("Due date").fill(today);
  });

  // The starter dashboard has a Personal tasks widget with both.
  await page.goto("/?context=personal");
  const widget = page.getByTestId("task-widget");
  await expect(widget.getByTestId("compact-task")).toHaveCount(2);

  // Only high priority: set in the widget's settings and saved with the layout.
  await page.getByTestId("dashboard-customize").click();
  await page.getByRole("button", { name: "Arrange Personal tasks" }).click();
  const settings = page.getByTestId("task-widget-settings");
  await settings.getByRole("checkbox", { name: "High" }).check();
  await page.getByTestId("dashboard-save").click();
  await expect(page.getByTestId("dashboard-editor")).toHaveCount(0);
  await expect(widget.getByTestId("task-widget-scope")).toContainText("Priority: High");
  await expect(widget.getByTestId("compact-task")).toHaveCount(1);
  await widget.getByRole("checkbox", { name: "Completed: Call the plumber" }).check();
  await page.goto("/tasks?status=all");
  await expect(page.getByTestId("task-row").filter({ hasText: "Call the plumber" })).toContainText(
    "Completed",
  );

  // The calendar: today's cell shows both; choosing the day lists them to complete.
  await page.goto("/tasks");
  await page.getByTestId("task-view-switch").getByRole("link", { name: "Calendar" }).click();
  await expect(page).toHaveURL(/\/tasks\/calendar/);
  const day = page.locator(`[data-testid="calendar-day"][data-date="${today}"]`);
  await expect(day).toContainText("Call the plumber");
  await expect(day).toContainText("Done");
  await day.getByRole("link").click();
  const panel = page.getByTestId("calendar-day-panel");
  await panel.getByRole("checkbox", { name: "Completed: Sort the post" }).check();
  await page.reload();
  await expect(
    page.getByTestId("calendar-day-panel").getByRole("checkbox", {
      name: "Completed: Sort the post",
    }),
  ).toBeChecked();

  // Week view and moving between weeks keep the filters in the address.
  await page.getByRole("link", { name: "Week", exact: true }).click();
  await expect(page.getByTestId("calendar-day")).toHaveCount(7);
  await page.getByRole("link", { name: "Next week" }).click();
  await expect(page.locator(`[data-testid="calendar-day"][data-date="${today}"]`)).toHaveCount(0);
  await page.getByRole("link", { name: "Today", exact: true }).click();
  await expect(page.locator(`[data-testid="calendar-day"][data-date="${today}"]`)).toHaveCount(1);
});

for (const scheme of ["light", "dark"] as const) {
  test(`calendar and attachments by keyboard in the ${scheme} theme`, async ({ page, baseURL }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await newAdult(page, baseURL, "Ward");
    await createList(page, "/tasks", "House");
    await page.goto("/tasks");
    await addTask(page, "Water the plants", async (p) => {
      await p.getByLabel("Due date").fill(londonToday());
    });

    await page.goto("/tasks/calendar");
    expect(await axeViolations(page)).toEqual([]);
    const todayLink = page.getByRole("link", { name: /today, (selected, )?1 task$/ });
    await todayLink.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/day=/);
    await expect(page.getByTestId("calendar-day-panel")).toContainText("Water the plants");
    expect(await axeViolations(page)).toEqual([]);

    await page
      .getByTestId("calendar-day-panel")
      .getByRole("link", { name: "Water the plants" })
      .click();
    // The file picker is a native input: it takes keyboard focus behind its visible label.
    await page.getByTestId("attachment-input").focus();
    await expect(page.getByTestId("attachment-input")).toBeFocused();
    await attach(page, "plants.png", "image/png", PNG);
    expect(await axeViolations(page)).toEqual([]);
    await page.getByRole("button", { name: "Remove plants.png" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Remove plants.png" })).toBeFocused();
  });
}
