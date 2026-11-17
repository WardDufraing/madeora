import { registerConfirmed, signIn } from "../support/accounts";
import { expect, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile } from "../support/database";
import { homeScreens } from "../support/screens";

// S48: denied states on every Home screen; offline on Tasks.
//  - Denied: a signed-in person who is not in a Home reaches none of its screens and never sees
//    its name; a plain Member reaches the manager-only screens as a clear "not allowed" state.
//  - Offline: a change made without a connection is never shown as saved; the form keeps what was
//    typed and the request is sent once the connection returns.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
  // The browser logs the failed requests of the offline tests and the deliberate refusals.
  allowedConsoleErrors: [/status of (403|404)|ERR_INTERNET_DISCONNECTED|Failed to fetch/],
});

test("a person outside a Home reaches none of its screens and never sees its name", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(10 * 60_000);
  const owner = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(owner.email, "Ann", "#2563eb");
  const homeId = createHomeFor(owner.email, "Ann's secret flat");

  const outsider = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(outsider.email, "Bo", "#2563eb");
  await signIn(page, outsider);

  const leaks: string[] = [];
  const reached: string[] = [];
  for (const path of homeScreens) {
    await page.goto(`/homes/${homeId}${path}`);
    // Every one of them lands on the dashboard (with a neutral notice), never on the Home.
    if (page.url().includes(homeId)) reached.push(path);
    const text = await page.locator("body").innerText();
    if (/Ann's secret flat/.test(text)) leaks.push(path);
  }
  expect(reached, "screens that did not refuse an outsider").toEqual([]);
  expect(leaks, "screens that named the Home to an outsider").toEqual([]);
});

test("a plain Member sees the manager-only screens as not allowed", async ({ page, baseURL }) => {
  test.setTimeout(5 * 60_000);
  const owner = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(owner.email, "Ann", "#2563eb");
  const homeId = createHomeFor(owner.email, "Ann's flat");
  const member = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(member.email, "Bo", "#2563eb");
  addMember(homeId, member.email, "member");
  await signIn(page, member);

  await page.goto(`/homes/${homeId}/displays`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: /pair/i })).toHaveCount(0);
  await expect(page.getByText("Only for Home managers")).toBeVisible();

  await page.goto(`/homes/${homeId}/invitations`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: /invite/i })).toHaveCount(0);
});

test("a change made offline is never shown as saved and is sent once the connection returns", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(3 * 60_000);
  const account = await registerConfirmed(baseURL ?? "");
  createHomeFor(account.email, "Thuis");
  await signIn(page, account);
  await page.goto("/tasks/manage");
  await page.getByTestId("list-new").fill("Errands");
  await page.getByRole("button", { name: "Create list" }).click();
  await expect(page.getByTestId("manage-list").filter({ hasText: "Errands" })).toBeVisible();

  // Tasks: a change made offline is never shown as saved. The form keeps its text and stays
  // waiting (the request is held until the connection returns), and no task appears.
  await page.goto("/tasks");
  const open = page.getByTestId("new-task-open");
  const form = page.getByTestId("new-task-form");
  await expect(open.or(form)).toBeVisible();
  if (await open.isVisible()) await open.click();
  await page.getByLabel("Title").fill("Write to the landlord");
  await context.setOffline(true);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByRole("button", { name: "Add task" })).toBeDisabled();
  await expect(page.getByLabel("Title")).toHaveValue("Write to the landlord");
  await expect(page.getByTestId("task-row")).toHaveCount(0);

  // Back online the held request is sent without retyping, and the task exists exactly once.
  await context.setOffline(false);
  await expect(
    page.getByTestId("task-row").filter({ hasText: "Write to the landlord" }),
  ).toHaveCount(1);
  // A late duplicate would show after a fresh read, so read again.
  await page.reload();
  await expect(
    page.getByTestId("task-row").filter({ hasText: "Write to the landlord" }),
  ).toHaveCount(1);
});
