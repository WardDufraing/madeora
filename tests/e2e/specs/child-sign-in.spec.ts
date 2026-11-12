import type { Page } from "@playwright/test";

import { registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { sql } from "../support/database";

// S42: a guardian sets up a child's PIN, a Home manager approves this browser as a household
// device, and the child signs in with the PIN there. The same PIN is refused on a browser that is
// not approved, a wrong PIN is refused, and the PIN never shows up in the page or in the database.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 800 },
});

const PIN = "4827";

async function adultWithHome(page: Page, baseURL: string | undefined) {
  const account = await registerConfirmed(baseURL ?? "");
  await signIn(page, account);
  await page.goto("/homes/new");
  await page.getByRole("textbox", { name: /Home name/ }).fill("Thuis");
  await page.getByRole("button", { name: "Create Home" }).click();
  await page.waitForURL(/\/homes\/[0-9a-f-]{36}$/);
  return { account, homeId: page.url().split("/").pop() ?? "" };
}

test("a child signs in with their PIN only on an approved household device", async ({
  page,
  baseURL,
  browser,
}) => {
  const { homeId } = await adultWithHome(page, baseURL);

  // The guardian adds Mia, sets her PIN and turns PIN sign-in on.
  await page.goto(`/homes/${homeId}/children/new`);
  await page.getByRole("textbox", { name: "Name" }).fill("Mia");
  await page.getByRole("button", { name: "Add child" }).click();
  await page.waitForURL(/\/children\/[0-9a-f-]{36}\?created=1$/);
  await page.getByLabel("New PIN").fill(PIN);
  await page.getByRole("button", { name: "Set PIN" }).click();
  await expect(page.getByText("PIN set.")).toBeVisible();
  await expect(page.getByLabel("New PIN")).toHaveValue("");
  await page.getByRole("checkbox", { name: /PIN sign-in on approved household devices/ }).check();
  await page.getByRole("button", { name: "Save sign-in settings" }).click();
  await expect(page.getByText("Sign-in settings saved.")).toBeVisible();
  expect(await page.content()).not.toContain(PIN);

  // The Owner approves this browser in the Home settings.
  await page.goto(`/homes/${homeId}/settings`);
  await page.getByRole("textbox", { name: /Name for this device/ }).fill("Kitchen tablet");
  await page.getByRole("button", { name: "Approve this device" }).click();
  await expect(page.getByText("This device is approved for PIN sign-in.")).toBeVisible();

  // An adult is still signed in here: the device asks them to sign out first.
  await page.goto("/household");
  await expect(page.getByText(/An adult is signed in on this device/)).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL((url) => url.pathname !== "/household");

  await page.goto("/household");
  await expect(page.getByRole("heading", { name: "Who are you?" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Mia" }).click();
  await page.getByLabel("Your PIN").fill("9512");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByText("That didn't work. Check what you typed and try again."),
  ).toBeVisible();
  await expect(page.getByLabel("Your PIN")).toHaveValue("");

  await page.getByLabel("Your PIN").fill(PIN);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/child$/);
  await expect(page.getByTestId("child-session-info")).toContainText("Signed in with your PIN");
  expect(await axeViolations(page)).toEqual([]);

  // Back on the device screen the next child is asked who they are, not handed Mia's session.
  await page.goto("/household");
  await expect(page.getByRole("heading", { name: "Who are you?" })).toBeVisible();

  // A browser that was never approved cannot use a PIN at all.
  const other = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const otherPage = await other.newPage();
  await otherPage.goto(`${baseURL ?? ""}/household`);
  await expect(otherPage.getByTestId("household-not-approved")).toBeVisible();
  const refused = await otherPage.request.post(`${baseURL ?? ""}/api/v1/child-sign-in/pin`, {
    headers: { "content-type": "application/json", origin: baseURL ?? "" },
    data: {
      childMembershipId: sqlChildMembership(homeId),
      pin: PIN,
    },
  });
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toEqual({ error: "device-not-approved" });
  await other.close();

  // The database holds only the scrypt hash, and no audit record carries the PIN.
  expect(
    sql(
      `select count(*) from private.child_home_pins
       where home_id = :'home'::uuid and pin_hash like 'scrypt$15$8$1$%' and pin_hash not like '%' || :'pin' || '%';`,
      { home: homeId, pin: PIN },
    ),
  ).toBe("1");
  expect(
    sql(
      `select count(*) from private.audit_events e
       where e.home_id = :'home'::uuid and to_jsonb(e)::text like '%' || :'pin' || '%';`,
      { home: homeId, pin: PIN },
    ),
  ).toBe("0");
});

function sqlChildMembership(homeId: string): string {
  return sql(
    `select m.id from public.home_memberships m
     join public.child_profiles c on c.user_id = m.user_id
     where m.home_id = :'home'::uuid limit 1;`,
    { home: homeId },
  );
}
