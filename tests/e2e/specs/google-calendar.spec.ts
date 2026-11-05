import { registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";

// S33: Google Calendar settings. CI has no Google Calendar client configured, so the page must say the
// connection is not available (never offer a connect button that cannot work) and stay accessible. The
// OAuth flow, sync and privacy rules are covered by unit, route and database tests.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
});

test("settings lead to Google Calendar, which says it is not available here", async ({
  page,
  baseURL,
}) => {
  const account = await registerConfirmed(baseURL ?? "");
  await signIn(page, account);
  await page.goto("/settings");
  await page.getByTestId("google-calendar-link").click();
  await expect(page).toHaveURL(/\/settings\/google-calendar$/);
  await expect(page.getByRole("heading", { level: 1, name: "Google Calendar" })).toBeVisible();
  await expect(page.getByTestId("google-not-available")).toBeVisible();
  await expect(page.getByTestId("google-connect")).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
});
