import type { Browser, Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile } from "../support/database";

// S20: chores core. A chore manager creates a rotating weekly chore with a required step; another
// member completes it, naming who did the work; the history shows it to the Home's members only.
// Then this and following occurrences change after the preview, an occurrence is skipped and
// reopened, the entire series goes to the trash and comes back. Keyboard and axe in both themes.
// Homes are set up directly in the throwaway test database (invitations are covered elsewhere).
// The "Shared chore" journey (Project-entry): a manager creates a chore from a template, assigns it
// and requires approval; the assignee submits it from the Home dashboard's widget; the Owner
// approves it from the Pending Approvals widget; the widgets and the Home-wide history update for
// the Home's members. Then a bulk change with its per-occurrence preview.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
  // The browser logs the deliberate refusals (a stranger's forged completion).
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

async function addRotatingChore(page: Page, title: string): Promise<void> {
  await page.getByTestId("new-chore-open").click();
  await page.getByLabel("Title").fill(title);
  await page.getByTestId("repeat-frequency").selectOption("weekly");
  await page.getByRole("radio", { name: "Rotation" }).check();
  await page.getByTestId("rotation-add-select").selectOption({ label: "you" });
  await page.getByTestId("rotation-add").click();
  await page.getByTestId("rotation-add-select").selectOption({ label: "Bea" });
  await page.getByTestId("rotation-add").click();
  await expect(page.getByTestId("rotation-preview").getByRole("listitem")).toHaveText([
    /: you$/,
    /: Bea$/,
    /: you$/,
    /: Bea$/,
    /: you$/,
  ]);
  await page.getByTestId("chore-add-step").click();
  await page.getByLabel("Step 1", { exact: true }).fill("Sort the glass");
  await page.getByLabel("Required before completing").check();
  await page.getByTestId("chore-submit").click();
  await expect(page.getByTestId("new-chore-view")).toBeVisible();
}

test("a shared rotating chore: complete for the turn of another, history, scopes, skip and trash", async ({
  page,
  browser,
  baseURL,
}) => {
  // A long journey through several pages and three browsers.
  test.slow();
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  const bea = await secondAdult(browser, baseURL, "Bea");
  addMember(homeId, bea.account.email, "member");
  const base = `/homes/${homeId}/chores`;

  // The sidebar's Chores follows the open Home.
  await page.goto(`/homes/${homeId}`);
  await page
    .getByRole("navigation", { name: /main/i })
    .getByRole("link", { name: "Chores" })
    .click();
  await expect(page).toHaveURL(new RegExp(`${base}$`));
  await addRotatingChore(page, "Take out the bins");
  // Today's turn is Ward's; next week's is Bea's.
  const rows = page.getByTestId("chore-row").filter({ hasText: "Take out the bins" });
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId("chores-group-today").getByTestId("chore-row")).toContainText(
    "you",
  );
  await expect(page.getByTestId("chores-group-upcoming").getByTestId("chore-row")).toContainText(
    "Bea",
  );

  // Bea, a plain member, completes Ward's turn: she ticks the required step and says she did it.
  await bea.page.goto(base);
  await expect(bea.page.getByText("Manage chores and categories")).toHaveCount(0);
  const today = bea.page.getByTestId("chores-group-today").getByTestId("chore-row");
  await expect(today).toContainText("Ward");
  // A required step is open, so there is no one-click completion.
  await expect(today.getByTestId("chore-quick-complete")).toHaveCount(0);
  await today.getByRole("link").click();
  // The link navigates on the client: wait for the occurrence's address before keeping it.
  await expect(bea.page).toHaveURL(/\/chores\/[0-9a-f-]{36}/);
  const occurrenceUrl = bea.page.url();
  await expect(bea.page.getByTestId("chore-skip-open")).toHaveCount(0);
  await bea.page.getByRole("checkbox", { name: /Sort the glass/ }).check();
  await expect(bea.page.getByRole("heading", { name: /Checklist/ })).toContainText(
    "1 of 1 steps done",
  );
  await bea.page.getByTestId("chore-complete-open").click();
  const dialog = bea.page.getByRole("dialog", { name: "Complete this chore" });
  await expect(dialog.getByTestId("chore-contributor")).toHaveValue("");
  await dialog.getByTestId("chore-contributor").selectOption({ label: "you" });
  await dialog.getByTestId("chore-note-input").fill("Glass sorted too");
  expect(await axeViolations(bea.page)).toEqual([]);
  await dialog.getByTestId("chore-complete-confirm").click();
  await expect(bea.page.getByTestId("chore-status")).toContainText("Done by you, recorded by you");

  // Ward sees who did it; the assignment and the rotation did not change.
  await page.goto(occurrenceUrl);
  await expect(page.getByTestId("chore-status")).toContainText("Done by Bea, recorded by Bea");
  await expect(page.getByTestId("chore-assignees")).toContainText("you");
  await expect(page.getByTestId("chore-note")).toContainText("Glass sorted too");
  const history = page.getByTestId("chore-history");
  await expect(history).toContainText("Done by Bea, recorded by Bea");
  // Today stays Ward's turn although Bea did it; next week's is still hers.
  const nextDates = page.getByTestId("chore-next-dates").getByRole("listitem");
  await expect(nextDates.first()).toContainText("you");
  await expect(nextDates.nth(1)).toContainText("Bea");

  // A stranger to the Home sees nothing and cannot complete it.
  const stranger = await secondAdult(browser, baseURL, "Cas");
  await stranger.page.goto(occurrenceUrl);
  await expect(stranger.page.getByText("That Home isn't available to you.")).toBeVisible();
  const occurrenceId = occurrenceUrl.split("/").pop() ?? "";
  const peek = await stranger.page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/chores/${id}/history`);
    const complete = await fetch(`/api/v1/chore-occurrences/${id}/completion`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contributor: id, note: null }),
    });
    return [response.status, complete.status];
  }, occurrenceId);
  expect(peek).toEqual([404, 404]);
  await stranger.close();

  // Next week's occurrence: change this and following (the estimate) after the preview.
  await page.goto(base);
  await page
    .getByTestId("chores-group-upcoming")
    .getByTestId("chore-row")
    .getByRole("link")
    .click();
  await page.getByTestId("chore-edit-open").click();
  await page.getByRole("radio", { name: "This and following occurrences" }).check();
  await page.getByLabel("Estimated time in minutes (optional)").fill("10");
  await page.getByTestId("chore-edit-check").click();
  await expect(page.getByTestId("chore-edit-preview")).toContainText("One occurrence is updated");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByTestId("chore-edit-save").click();
  await expect(page.getByText("about 10 minutes")).toBeVisible();

  // Skip it, then reopen it (chore managers).
  await page.getByTestId("chore-skip-open").click();
  const skip = page.getByRole("dialog", { name: "Skip this occurrence" });
  await skip.getByLabel("Reason (optional)").fill("Away that week");
  await skip.getByTestId("chore-skip-confirm").click();
  await expect(page.getByTestId("chore-status")).toContainText("Skipped by you");
  await page.getByTestId("chore-reopen").click();
  await expect(page.getByTestId("chore-status")).toContainText("Not done yet.");

  // Delete the entire series: the open occurrence goes to the trash, the history stays.
  await page.getByTestId("chore-delete-open").click();
  const remove = page.getByRole("dialog", { name: "Delete which occurrences?" });
  await remove.getByRole("radio", { name: /The entire series/ }).check();
  await expect(remove.getByTestId("chore-delete-impact")).toContainText(
    "One open occurrence goes to the trash; one done or skipped occurrence stays.",
  );
  await remove.getByTestId("chore-delete-confirm").click();
  await expect(page.getByText("Moved to this Home's trash.")).toBeVisible();
  await expect(page.getByTestId("chore-row")).toHaveCount(0);
  await page.goto(`${base}/manage`);
  await expect(page.getByText("1 ended chore")).toBeVisible();

  await page.goto(`/homes/${homeId}/trash`);
  const entry = page.getByTestId("trash-entry").filter({ hasText: "Chore occurrences" });
  await entry.getByRole("checkbox").check();
  await page.getByTestId("trash-restore").click();
  await expect(page.getByTestId("trash-result")).toContainText("Restored");
  await page.goto(base);
  await expect(page.getByTestId("chore-row").filter({ hasText: "Take out the bins" })).toHaveCount(
    1,
  );
  await bea.close();
});

const widget = (page: Page, name: string | RegExp) =>
  page.getByTestId("dashboard-widget").filter({ has: page.getByRole("heading", { name }) });

async function addOneOff(page: Page, title: string): Promise<void> {
  await page.getByTestId("new-chore-open").click();
  await page.getByLabel("Title").fill(title);
  await page.getByTestId("chore-submit").click();
  await expect(page.getByTestId("new-chore-view")).toBeVisible();
}

test("the shared chore journey: template, approval from widgets, Home history and bulk", async ({
  page,
  browser,
  baseURL,
}) => {
  test.slow();
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  const bea = await secondAdult(browser, baseURL, "Bea");
  addMember(homeId, bea.account.email, "member");
  const base = `/homes/${homeId}/chores`;

  // A template, managed by the chore manager.
  await page.goto(`${base}/manage`);
  await page.getByTestId("chore-template-new").click();
  const templateForm = page.getByTestId("chore-template-form");
  await templateForm.getByLabel("Template title").fill("Clean the bathroom");
  await templateForm.getByLabel("Instructions (optional)").fill("Top to bottom");
  await templateForm.getByTestId("chore-add-step").click();
  await templateForm.getByLabel("Step 1", { exact: true }).fill("Mirror");
  await templateForm.getByTestId("chore-template-save").click();
  await expect(page.getByTestId("chore-template")).toContainText("1 step");

  // A chore from it, for Bea, needing approval.
  await page.goto(base);
  await page.getByTestId("new-chore-open").click();
  await page.getByLabel("Start from a template").selectOption({ label: "Clean the bathroom" });
  await page.getByTestId("new-chore-template-apply").click();
  await expect(page.getByLabel("Title")).toHaveValue("Clean the bathroom");
  await expect(page.getByLabel("Step 1", { exact: true })).toHaveValue("Mirror");
  await page.getByRole("radio", { name: "Fixed members" }).check();
  await page.getByRole("checkbox", { name: "Bea" }).check();
  await page.getByTestId("chore-requires-approval").check();
  await page.getByTestId("chore-submit").click();
  await expect(page.getByTestId("new-chore-view")).toBeVisible();

  // The Home dashboard gets the three chore widgets.
  await page.goto(`/homes/${homeId}`);
  await page.getByTestId("dashboard-customize").click();
  const catalogue = page.getByTestId("dashboard-catalogue");
  await catalogue.getByRole("button", { name: "Add My Chores" }).click();
  await catalogue.getByRole("button", { name: "Add All Home Chores" }).click();
  await catalogue.getByRole("button", { name: "Add Pending Approvals" }).click();
  await page.getByTestId("dashboard-save").click();
  await expect(page.getByTestId("dashboard-editor")).toHaveCount(0);
  await expect(widget(page, "All Home Chores")).toContainText("Clean the bathroom");
  await expect(widget(page, "My Chores")).toContainText("Nothing here");
  await expect(widget(page, "Pending Approvals")).toContainText("Nothing waits for approval");

  // Bea submits it from her My Chores widget; she is no reviewer.
  await bea.page.goto(`/homes/${homeId}`);
  const mine = widget(bea.page, "My Chores");
  await expect(mine).toContainText("Clean the bathroom");
  await expect(widget(bea.page, "Pending Approvals")).toContainText("For chore reviewers");
  expect(await axeViolations(bea.page)).toEqual([]);
  await mine.getByRole("button", { name: "Submit Clean the bathroom for approval" }).click();
  await expect(mine).toContainText("Waiting for approval");

  // Ward approves it from the Pending Approvals widget.
  await page.reload();
  const approvals = widget(page, "Pending Approvals");
  await expect(approvals).toContainText("Clean the bathroom");
  await approvals.getByRole("button", { name: "Approve Clean the bathroom" }).click();
  const approve = page.getByRole("dialog", { name: "Approve this completion?" });
  await approve.getByTestId("chore-approve-confirm").click();
  await expect(approvals).toContainText("Nothing waits for approval");
  await expect(widget(page, "All Home Chores")).not.toContainText("Clean the bathroom");

  // The Home-wide history shows it to the Home's members, with a search and its chip.
  await bea.page.goto(`${base}/history?q=bathroom`);
  const rows = bea.page.getByTestId("home-history-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Done by you, recorded by you");
  await expect(rows.first()).toContainText("approved by Ward");
  await expect(bea.page.getByTestId("history-chips")).toContainText("Search: bathroom");
  expect(await axeViolations(bea.page)).toEqual([]);
  await bea.page.getByLabel("Approval").selectOption("none");
  await bea.page.getByRole("button", { name: "Apply filters" }).click();
  await expect(bea.page.getByText("Nothing matches")).toBeVisible();
  await bea.page.getByRole("link", { name: "Clear filters" }).click();
  await expect(rows).toHaveCount(1);

  // Bulk: two open chores reassigned to Bea after the per-occurrence preview.
  await page.goto(base);
  await addOneOff(page, "Dishes");
  await addOneOff(page, "Floor");
  await page.getByTestId("chore-bulk-open").click();
  // Both new chores are listed (the page refreshes after each save) before selecting them all.
  await expect(page.getByTestId("chore-bulk-checkbox")).toHaveCount(2);
  await page.getByRole("button", { name: /Select all shown/ }).click();
  await page.getByTestId("chore-bulk-member").selectOption({ label: "Bea" });
  await page.getByTestId("chore-bulk-review").click();
  const preview = page.getByRole("dialog", { name: "Review: Reassign" });
  await expect(preview.getByTestId("chore-bulk-preview").getByRole("listitem")).toHaveCount(2);
  await expect(preview).toContainText("Unassigned → Bea");
  expect(await axeViolations(page)).toEqual([]);
  await preview.getByTestId("chore-bulk-confirm").click();
  await expect(page.getByTestId("chore-bulk-results")).toContainText("2 changed");
  await expect(page.getByTestId("chore-row").filter({ hasText: "Dishes" })).toContainText("Bea");
  await bea.close();
});

for (const scheme of ["light", "dark"] as const) {
  test(`chore form, rotation order and dialogs by keyboard in the ${scheme} theme`, async ({
    page,
    browser,
    baseURL,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const ward = await newAdult(page, baseURL, "Ward");
    const homeId = createHomeFor(ward.email, "Thuis");
    const bea = await secondAdult(browser, baseURL, "Bea");
    addMember(homeId, bea.account.email, "member");
    await page.goto(`/homes/${homeId}/chores`);
    // The control stays disabled until React has hydrated, and focus() does not wait for that.
    // Sending Enter in a later step can miss it too: on CI the key went out while the page was
    // prefetching links, the form never opened, and focus was left on the document.
    const opener = page.getByTestId("new-chore-open");
    await expect(opener).toBeEnabled();
    await opener.press("Enter");
    await expect(page.getByLabel("Title")).toBeFocused();
    await page.keyboard.type("Water the plants");
    await page.getByTestId("repeat-frequency").selectOption("daily");
    await page.getByRole("radio", { name: "Rotation" }).check();
    await page.getByTestId("rotation-add-select").selectOption({ label: "you" });
    await page.getByTestId("rotation-add").press("Enter");
    await page.getByTestId("rotation-add-select").selectOption({ label: "Bea" });
    await page.getByTestId("rotation-add").press("Enter");
    // The order changes with a keyboard: Bea moves up.
    await page.getByRole("button", { name: "Move Bea up" }).press("Enter");
    await expect(page.getByTestId("rotation-member").first()).toContainText("Bea");
    await expect(page.getByTestId("rotation-preview").getByRole("listitem").first()).toContainText(
      "Bea",
    );
    expect(await axeViolations(page)).toEqual([]);
    await page.getByTestId("chore-submit").press("Enter");
    await page.getByTestId("new-chore-view").click();

    // Escape closes the delete dialog and returns focus to its button.
    await page.getByTestId("chore-delete-open").press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chore-delete-open")).toBeFocused();

    // The personal Chores page leads to the Home.
    await page.goto("/chores");
    await expect(page.getByTestId("personal-chores-home")).toHaveText("Chores of Thuis");
    expect(await axeViolations(page)).toEqual([]);
    await bea.close();
  });
}
