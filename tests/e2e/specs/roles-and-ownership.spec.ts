import type { Browser, Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile, sql } from "../support/database";

// S12: roles, Administrator rights, removal, leaving and ownership transfer. Each test makes its
// own accounts and Home; memberships and names are set up in the database, and every change under
// test is made through the app's own screens by the person allowed to make it.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 800 },
});

const UNAVAILABLE = "That Home isn't available to you.";

async function person(baseURL: string | undefined, name: string): Promise<Account> {
  const account = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(account.email, name, "#2563eb");
  return account;
}

async function signedIn(browser: Browser, account: Account): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await signIn(page, account);
  return page;
}

function membershipId(homeId: string, email: string): string {
  return sql(
    `select m.id from public.home_memberships m join auth.users u on u.id = m.user_id
     where m.home_id = :'home'::uuid and u.email = :'email';`,
    { home: homeId, email },
  );
}

/** A same-origin JSON request from the page, as the app's own code makes it. */
function apiFrom(page: Page, method: string, path: string, body: object): Promise<number> {
  return page.evaluate(
    async ({ method, path, body }) =>
      (
        await fetch(path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
    { method, path, body },
  );
}

async function expectNoAxeViolations(page: Page, label: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    expect(await axeViolations(page), `${label}, ${theme}`).toEqual([]);
  }
}

test("the Owner delegates removal; an Administrator removes a Member only, and removal ends access at once", async ({
  page,
  baseURL,
  browser,
}) => {
  const alice = await person(baseURL, "Alice");
  const bob = await person(baseURL, "Bob");
  const carol = await person(baseURL, "Carol");
  const dave = await person(baseURL, "Dave");
  const homeId = createHomeFor(alice.email, "Thuis");
  addMember(homeId, bob.email, "member");
  addMember(homeId, carol.email, "member");
  addMember(homeId, dave.email, "administrator");

  // Alice makes Bob an Administrator and grants him "Remove members".
  await signIn(page, alice);
  await page.goto(`/homes/${homeId}/members`);
  await page.getByRole("link", { name: "Manage: Bob" }).click();
  await page.waitForURL(/\/members\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("member-role")).toContainText("Member");
  await page.getByRole("radio", { name: "Administrator" }).check();
  await page.getByRole("button", { name: "Change role" }).click();
  await page
    .getByRole("dialog", { name: "Change Bob's role?" })
    .getByRole("button", { name: "Change role" })
    .click();
  await expect(page.getByText("Bob is now Administrator.")).toBeVisible();
  await expect(page.getByTestId("member-role")).toContainText("Administrator");
  const rights = page.getByRole("region", { name: "Administrator rights" });
  // Home settings, invitations, member removal, the Home dashboard (S17), Home tasks (S18), managing and approving chores (S20), and managing rewards, approving reward requests and managing points (S23).
  await expect(rights.getByRole("checkbox")).toHaveCount(10);
  for (const box of await rights.getByRole("checkbox").all()) await expect(box).not.toBeChecked();
  await rights.getByRole("checkbox", { name: /Remove members/ }).check();
  await expect(page.getByTestId("capabilities-preview")).toContainText("Remove members granted");
  await rights.getByRole("button", { name: "Save rights" }).click();
  await page
    .getByRole("dialog", { name: "Change Bob's rights?" })
    .getByRole("button", { name: "Save rights" })
    .click();
  await expect(page.getByText("Bob's rights are saved.")).toBeVisible();
  await expectNoAxeViolations(page, "member page");

  // Carol is on the Home's dashboard when she is removed.
  const carolPage = await signedIn(browser, carol);
  await carolPage.goto(`/homes/${homeId}`);
  await expect(carolPage.getByTestId("home-role")).toContainText("Member");

  // Bob sees his right, may manage Carol (a Member) but not Dave (an Administrator) or Alice.
  const bobPage = await signedIn(browser, bob);
  await bobPage.goto(`/homes/${homeId}/profile`);
  await expect(bobPage.getByTestId("your-permissions")).toContainText("Remove members");
  await bobPage.goto(`/homes/${homeId}/members`);
  await expect(bobPage.getByTestId("manage-member-link")).toHaveCount(1);
  await expect(bobPage.getByRole("link", { name: "Manage: Carol" })).toBeVisible();
  await bobPage.getByRole("link", { name: "Manage: Carol" }).click();
  await bobPage.waitForURL(/\/members\/[0-9a-f-]{36}$/);
  // Only removal: role, rights and ownership stay with the Owner.
  await expect(bobPage.getByRole("region", { name: "Role" })).toHaveCount(0);
  await expect(bobPage.getByRole("region", { name: "Make Owner" })).toHaveCount(0);
  await bobPage.getByRole("button", { name: "Remove Carol" }).click();
  const confirm = bobPage.getByRole("dialog", { name: "Remove Carol from Thuis?" });
  await expect(confirm).toContainText("Carol loses access to this Home at once");
  await confirm.getByRole("button", { name: "Remove" }).click();
  await bobPage.waitForURL(`**/homes/${homeId}/members?removed=1`);
  await expect(bobPage.getByText("The member was removed from this Home.")).toBeVisible();
  await expect(bobPage.getByTestId("member-name")).toHaveText(["Alice", "Bob (you)", "Dave"]);

  // Carol's next page load has no access, and the Home is gone from her switcher.
  await carolPage.reload();
  await expect(carolPage.getByText(UNAVAILABLE)).toBeVisible();
  await carolPage.goto(`/homes/${homeId}/members`);
  await expect(carolPage.getByText(UNAVAILABLE)).toBeVisible();
  await expect(carolPage.getByText("Thuis")).toHaveCount(0);

  // Forged requests from Bob to remove Dave (an Administrator) or Alice (the Owner), or to change
  // Dave's role, are refused by the server.
  const daveId = membershipId(homeId, dave.email);
  const aliceId = membershipId(homeId, alice.email);
  const base = `/api/v1/homes/${homeId}/members`;
  expect(
    await apiFrom(bobPage, "POST", `${base}/${daveId}/remove`, { expectedRole: "administrator" }),
  ).toBe(403);
  expect(
    await apiFrom(bobPage, "POST", `${base}/${aliceId}/remove`, { expectedRole: "owner" }),
  ).toBe(403);
  expect(
    await apiFrom(bobPage, "PATCH", `${base}/${daveId}`, {
      role: "member",
      expectedRole: "administrator",
    }),
  ).toBe(403);
  await page.goto(`/homes/${homeId}/members`);
  await expect(page.getByTestId("member-name")).toHaveText(["Alice (you)", "Bob", "Dave"]);
});

test.describe("ownership transfer", () => {
  // The Owner's refused departure (409) is part of the journey.
  test.use({ allowedConsoleErrors: [/status of 409/] });

  test("ownership moves only when the nominated member accepts, and then the former Owner may leave", async ({
    page,
    baseURL,
    browser,
  }) => {
    const alice = await person(baseURL, "Alice");
    const bob = await person(baseURL, "Bob");
    const homeId = createHomeFor(alice.email, "Thuis");
    addMember(homeId, bob.email, "member");

    // The Owner's leave page offers only the transfer, and explains closing.
    await signIn(page, alice);
    await page.goto(`/homes/${homeId}/profile`);
    await page.getByTestId("leave-link").click();
    await page.waitForURL(`**/homes/${homeId}/leave`);
    await expect(page.getByText(/You're the Owner of Thuis/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Leave/ })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Close the Home" })).toContainText(
      "isn't available in Madeora yet",
    );
    await expectNoAxeViolations(page, "owner leave page");
    // The server refuses the Owner's departure too.
    expect(await apiFrom(page, "POST", `/api/v1/homes/${homeId}/leave`, {})).toBe(409);

    // First request: Bob declines; Alice stays the Owner.
    await page.getByRole("button", { name: "Ask Bob to become Owner" }).click();
    await page
      .getByRole("dialog", { name: "Ask Bob to become the Owner of Thuis?" })
      .getByRole("button", { name: "Send request" })
      .click();
    await page.waitForURL(`**/homes/${homeId}`);
    await expect(page.getByTestId("ownership-transfer-banner")).toContainText(
      "Waiting for Bob to accept ownership",
    );

    const bobPage = await signedIn(browser, bob);
    await bobPage.goto(`/homes/${homeId}`);
    const banner = bobPage.getByTestId("ownership-transfer-banner");
    await expect(banner).toContainText("You've been asked to become the Owner of Thuis");
    await expectNoAxeViolations(bobPage, "transfer banner");
    await banner.getByRole("button", { name: "Decline" }).click();
    await expect(bobPage.getByText("You declined. Nothing changed.")).toBeVisible();

    await page.reload();
    await expect(
      page.getByText("Bob declined to become Owner. You're still the Owner."),
    ).toBeVisible();
    await expect(page.getByTestId("home-role")).toContainText("Owner");

    // Second request, from Bob's member page: Bob accepts and the roles swap.
    await page.goto(`/homes/${homeId}/members`);
    await page.getByRole("link", { name: "Manage: Bob" }).click();
    await page.getByRole("button", { name: "Ask Bob to become Owner" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Send request" }).click();
    await page.waitForURL(`**/homes/${homeId}`);

    await bobPage.reload();
    await bobPage.getByRole("button", { name: "Accept and become Owner" }).click();
    await bobPage
      .getByRole("dialog", { name: "Become the Owner of Thuis?" })
      .getByRole("button", { name: "Become Owner" })
      .click();
    await expect(bobPage.getByText("You are now the Owner of Thuis.")).toBeVisible();
    // The confirmation stays once the page has reloaded without the banner.
    await bobPage.waitForURL(`**/homes/${homeId}?transfer=accepted`);
    await bobPage.reload();
    await expect(bobPage.getByText("You are now the Owner of Thuis.")).toBeVisible();
    await expect(bobPage.getByTestId("home-role")).toContainText("Owner");

    // The same address claims nothing for Alice, who is no longer the Owner.
    await page.goto(`/homes/${homeId}?transfer=accepted`);
    await expect(page.getByTestId("home-role")).toContainText("Member");
    await expect(page.getByText("You are now the Owner of Thuis.")).toHaveCount(0);
    await page.goto(`/homes/${homeId}/members`);
    await expect(page.getByTestId("member-name")).toHaveText(["Bob", "Alice (you)"]);

    // Now a Member, Alice leaves with the keyboard.
    await page.goto(`/homes/${homeId}/leave`);
    await expect(page.getByText("You can leave Thuis at any time")).toBeVisible();
    await expectNoAxeViolations(page, "leave page");
    await page.getByRole("button", { name: "Leave Thuis" }).focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Leave Thuis?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Leave" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForURL((url) => url.pathname === "/");
    await expect(page.getByText("You left the Home.")).toBeVisible();
    await page.goto(`/homes/${homeId}`);
    await expect(page.getByText(UNAVAILABLE)).toBeVisible();

    // Bob, the only member left, is the Owner and cannot leave.
    expect(await apiFrom(bobPage, "POST", `/api/v1/homes/${homeId}/leave`, {})).toBe(409);
  });
});
