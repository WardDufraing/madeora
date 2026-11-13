import { registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { sql } from "../support/database";

// S43: a fresh tablet shows only a pairing code; a Home manager pairs it from their own session
// into the right Home under a name; the tablet becomes that Home's display without anyone signed
// in on it, survives a restart and the manager signing out, cannot open member pages, and returns
// to the pairing screen once revoked. A used code cannot be used again.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 800 },
  // The browser's own log lines for the deliberately refused requests.
  allowedConsoleErrors: [/status of 40[19]/],
});

test("a manager pairs a tablet as a Household Display and revokes it", async ({
  page,
  baseURL,
  browser,
}) => {
  const base = baseURL ?? "";
  const account = await registerConfirmed(base);
  await signIn(page, account);
  await page.goto("/homes/new");
  await page.getByRole("textbox", { name: /Home name/ }).fill("Thuis");
  await page.getByRole("button", { name: "Create Home" }).click();
  await page.waitForURL(/\/homes\/[0-9a-f-]{36}$/);
  const homeId = page.url().split("/").pop() ?? "";

  // The fresh tablet: instructions and a code, nothing of any Home.
  const tablet = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const screen = await tablet.newPage();
  await screen.goto(`${base}/display`);
  await expect(
    screen.getByRole("heading", { name: "Set up this Household Display" }),
  ).toBeVisible();
  const codeText = (await screen.getByTestId("pairing-code").textContent()) ?? "";
  expect(codeText).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await expect(screen.getByText("Thuis")).toHaveCount(0);
  expect(await axeViolations(screen)).toEqual([]);

  // The Owner pairs it from Home settings → Household Displays.
  await page.goto(`/homes/${homeId}/settings`);
  await page.getByTestId("home-displays-link").click();
  await page.waitForURL(/\/displays$/);
  await page.getByRole("textbox", { name: /Pairing code/ }).fill(codeText.toLowerCase());
  await page.getByRole("button", { name: "Check code" }).click();
  await expect(page.getByTestId("display-review")).toContainText(`Code ${codeText}`);
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("textbox", { name: /Display name/ }).fill("Kitchen");
  await page.getByRole("button", { name: "Approve display" }).click();
  await expect(page.getByText(/Kitchen is paired/)).toBeVisible();
  await expect(page.getByTestId("display-row")).toContainText("Kitchen");

  // The tablet turns into the display by itself.
  await expect(screen.getByTestId("display-board")).toBeVisible({ timeout: 15_000 });
  await expect(screen.getByRole("heading", { name: "Thuis" })).toBeVisible();
  await expect(screen.getByText("Household Display: Kitchen")).toBeVisible();
  expect(await axeViolations(screen)).toEqual([]);

  // A replayed code is refused, also for the same manager.
  await page.reload();
  await page.getByRole("textbox", { name: /Pairing code/ }).fill(codeText);
  await page.getByRole("button", { name: "Check code" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "This code has already been used.",
  );

  // The manager signs out; the display keeps working after a restart.
  await page.goto("/settings");
  await page.context().clearCookies();
  await screen.close();
  const restarted = await tablet.newPage();
  await restarted.goto(`${base}/display`);
  await expect(restarted.getByTestId("display-board")).toBeVisible();

  // The display reaches nothing else: member pages send it back, the API refuses it.
  await restarted.goto(`${base}/homes/${homeId}/settings`);
  await restarted.waitForURL(/\/display$/);
  const refused = await restarted.request.post(`${base}/api/v1/homes/${homeId}/displays/check`, {
    headers: { "content-type": "application/json", origin: base },
    data: { code: codeText },
  });
  expect(refused.status()).toBe(401);

  // The Owner revokes it; the display goes back to an empty pairing screen.
  await signIn(page, account);
  await page.goto(`/homes/${homeId}/displays`);
  await page.getByRole("button", { name: "Revoke Kitchen" }).click();
  await expect(page.getByText(/The display is revoked/)).toBeVisible();
  await restarted.reload();
  await expect(
    restarted.getByRole("heading", { name: "Set up this Household Display" }),
  ).toBeVisible();
  await expect(restarted.getByText("Thuis")).toHaveCount(0);
  await expect(restarted.getByTestId("pairing-code")).not.toHaveText(codeText);
  await tablet.close();

  // Only hashes of the code are stored, and no audit record carries it.
  const bare = codeText.replace("-", "");
  expect(
    sql(
      `select count(*) from private.display_pairing_requests
       where to_jsonb(display_pairing_requests)::text like '%' || :'code' || '%';`,
      { code: bare },
    ),
  ).toBe("0");
  expect(
    sql(
      `select count(*) from private.audit_events e
       where e.home_id = :'home'::uuid and to_jsonb(e)::text like '%' || :'code' || '%';`,
      { home: homeId, code: bare },
    ),
  ).toBe("0");
});
