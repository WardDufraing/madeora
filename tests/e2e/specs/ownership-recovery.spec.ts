import type { Browser, Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile, sql } from "../support/database";
import { runJobs } from "../support/jobs";
import { waitForEmail } from "../support/mail";

// S12b: verified Home ownership recovery. A long-standing member asks Madeora to make them the
// Owner of a Home whose Owner cannot be reached; Madeora staff review it in the app, another member
// objects (which pauses it), staff resume it, and after the objection period the member accepts.
// The Owner never signs in during the journey: signing in would stop the request.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 800 },
});

const STATEMENT =
  "Alice moved abroad in March and has not answered calls, messages or email since. " +
  "Her sister confirmed she lost her phone and email. You can reach me for a video call.";

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

async function expectNoAxeViolations(page: Page, label: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    expect(await axeViolations(page), `${label}, ${theme}`).toEqual([]);
  }
}

test("a member recovers ownership through staff review, an objection and the waiting period", async ({
  page,
  baseURL,
  browser,
}) => {
  // Four accounts and three browsers through the whole review: longer than one ordinary test.
  test.slow();
  const alice = await person(baseURL, "Alice");
  const dave = await person(baseURL, "Dave");
  const erin = await person(baseURL, "Erin");
  const sam = await person(baseURL, "Sam");
  const homeId = createHomeFor(alice.email, "Thuis");
  addMember(homeId, dave.email, "member");
  addMember(homeId, erin.email, "administrator");
  // Dave and Erin joined long ago; Sam is Madeora staff (added in the SQL Editor in real life).
  sql(
    `update public.home_memberships set created_at = now() - interval '60 days'
       where home_id = :'home'::uuid;
     insert into private.madeora_staff (user_id, note)
       select id, 'e2e staff' from auth.users where email = :'email';`,
    { home: homeId, email: sam.email },
  );

  // Dave finds the way from the member directory and asks.
  await signIn(page, dave);
  await page.goto(`/homes/${homeId}/members`);
  await page.getByRole("link", { name: "Ask Madeora to review an ownership recovery" }).click();
  await page.waitForURL(`**/homes/${homeId}/recovery`);
  await expectNoAxeViolations(page, "recovery page");
  await page.getByRole("textbox", { name: /Your statement for Madeora staff/ }).fill(STATEMENT);
  await page.getByRole("button", { name: "Send to Madeora staff" }).click();
  await expect(page.getByText("Your request was sent to Madeora staff.")).toBeVisible();
  await expect(page.getByTestId("recovery-own-state")).toHaveText(
    "Your request is waiting for Madeora staff.",
  );

  // Erin sees only that a review is open, without the statement or who asked.
  const erinPage = await signedIn(browser, erin);
  await erinPage.goto(`/homes/${homeId}`);
  await expect(erinPage.getByTestId("recovery-member-notice")).toHaveText(
    "An ownership review is open for Thuis",
  );
  // Dave is listed as a member in the Home members widget (S17), like on the directory page, but
  // nothing outside it connects him to the review.
  await expect(erinPage.getByTestId("recovery-member-notice")).not.toContainText("Dave");
  await expect(
    erinPage.getByText(/Dave/).and(erinPage.locator(":not([data-testid=dashboard] *)")),
  ).toHaveCount(0);
  await expect(erinPage.getByText(STATEMENT)).toHaveCount(0);

  // Sam reviews it from the staff pages, reached from Settings.
  const samPage = await signedIn(browser, sam);
  await samPage.goto("/settings");
  await samPage.getByTestId("staff-link").click();
  await samPage.waitForURL("**/staff/ownership-recoveries");
  // Staff see every Home's requests; open this one.
  const recoveryId = sql(
    `select id from private.home_ownership_recoveries where home_id = :'home'::uuid;`,
    { home: homeId },
  );
  await samPage.locator(`a[href="/staff/ownership-recoveries/${recoveryId}"]`).click();
  await samPage.waitForURL(/\/staff\/ownership-recoveries\/[0-9a-f-]{36}$/);
  await expect(samPage.getByTestId("staff-statement")).toHaveText(STATEMENT);
  await expect(samPage.getByText(alice.email)).toBeVisible();
  await expectNoAxeViolations(samPage, "staff case page");
  await samPage.getByRole("button", { name: "Save decision" }).click();
  await expect(
    samPage.getByText(
      "Decision saved. The people involved are being notified; emails go out within a few minutes.",
    ),
  ).toBeVisible();
  runJobs();
  await waitForEmail(alice.email, "Someone asked to take over ownership of");
  await expect(samPage.getByTestId("staff-case-state")).toHaveText("In review");

  await samPage.getByRole("radio", { name: /Approve/ }).check();
  await samPage.getByRole("radio", { name: "Stays as a Member" }).check();
  await samPage
    .getByRole("textbox", { name: "Note" })
    .fill("Video call with Dave, ID checked; Alice's sister confirmed by phone.");
  await samPage.getByRole("button", { name: "Save decision" }).click();
  await expect(
    samPage.getByText(
      "Decision saved. The people involved are being notified; emails go out within a few minutes.",
    ),
  ).toBeVisible();
  runJobs();
  await waitForEmail(alice.email, "will move unless you act");
  await expect(samPage.getByTestId("staff-case-state")).toHaveText(
    "Approved, objection period running",
  );

  // Erin objects; the request pauses and staff see her reason.
  await erinPage.reload();
  await erinPage.getByRole("link", { name: "Open ownership recovery" }).click();
  await erinPage
    .getByRole("textbox", { name: /Your reason/ })
    .fill("I want to hear from Alice first.");
  await erinPage.getByRole("button", { name: "Object" }).click();
  await expect(
    erinPage.getByText("Your objection was sent. The request is paused for Madeora staff."),
  ).toBeVisible();
  await samPage.reload();
  await expect(samPage.getByTestId("staff-case-state")).toHaveText("Paused");
  await expect(samPage.getByText("I want to hear from Alice first.")).toBeVisible();
  await samPage.getByRole("radio", { name: "Resume" }).check();
  await samPage.getByRole("button", { name: "Save decision" }).click();
  await expect(
    samPage.getByText(
      "Decision saved. The people involved are being notified; emails go out within a few minutes.",
    ),
  ).toBeVisible();
  await expect(samPage.getByTestId("staff-case-state")).toHaveText(
    "Approved, objection period running",
  );

  // Before the period ends Dave cannot accept; then the 14 days pass.
  await page.reload();
  await expect(page.getByRole("button", { name: "Accept ownership" })).toHaveCount(0);
  sql(
    `update private.home_ownership_recoveries set objection_ends_at = now() - interval '1 minute'
       where home_id = :'home'::uuid and status = 'approved';`,
    { home: homeId },
  );
  await page.goto(`/homes/${homeId}`);
  await expect(page.getByTestId("recovery-claimant-notice")).toHaveText(
    "The objection period is over. You can accept ownership of Thuis now.",
  );
  await page.getByRole("link", { name: "Open ownership recovery" }).click();
  await page.getByRole("button", { name: "Accept ownership" }).click();
  await page
    .getByRole("dialog", { name: "Become the Owner of Thuis?" })
    .getByRole("button", { name: "Become Owner" })
    .click();
  await page.waitForURL(`**/homes/${homeId}?recovery=accepted`);
  await expect(page.getByText("You are now the Owner of Thuis.")).toBeVisible();
  await expect(page.getByTestId("home-role")).toContainText("Owner");

  // Alice, signing in later, is a Member and can appeal; staff see the appeal.
  const alicePage = await signedIn(browser, alice);
  await alicePage.goto("/?context=personal");
  await expect(alicePage.getByTestId("recovered-homes-notice")).toContainText(
    "Ownership of Thuis moved to another member",
  );
  await alicePage.getByRole("link", { name: "See what happened and appeal" }).click();
  await alicePage.waitForURL("**/settings/recoveries");
  await expect(alicePage.getByTestId("recovered-home")).toContainText(
    "You are still a Member of this Home.",
  );
  await alicePage
    .getByRole("textbox", { name: /Your appeal about Thuis/ })
    .fill("I never lost access; I was travelling without my phone.");
  await alicePage.getByRole("button", { name: "Send appeal" }).click();
  await expect(alicePage.getByText("Your appeal was sent to Madeora staff.")).toBeVisible();
  await alicePage.goto(`/homes/${homeId}`);
  await expect(alicePage.getByTestId("home-role")).toContainText("Member");

  await samPage.reload();
  await expect(samPage.getByTestId("staff-case-state")).toHaveText("Completed");
  await expect(
    samPage.getByText("I never lost access; I was travelling without my phone."),
  ).toBeVisible();
});

test.describe("outside the staff list", () => {
  // The staff page answers 404 to anyone else, which the browser logs.
  test.use({ allowedConsoleErrors: [/status of 404/] });

  test("the staff pages do not exist for anyone else, and the Owner stops a request by opening the Home", async ({
    page,
    baseURL,
    browser,
  }) => {
    const alice = await person(baseURL, "Alice");
    const dave = await person(baseURL, "Dave");
    const homeId = createHomeFor(alice.email, "Thuis");
    addMember(homeId, dave.email, "member");
    sql(
      `update public.home_memberships set created_at = now() - interval '60 days'
       where home_id = :'home'::uuid;`,
      { home: homeId },
    );

    await signIn(page, dave);
    const notFound = await page.goto("/staff/ownership-recoveries");
    expect(notFound?.status()).toBe(404);
    await page.goto(`/homes/${homeId}/recovery`);
    await page.getByRole("textbox", { name: /Your statement for Madeora staff/ }).fill(STATEMENT);
    await page.getByRole("button", { name: "Send to Madeora staff" }).click();
    await expect(page.getByText("Your request was sent to Madeora staff.")).toBeVisible();

    // Alice can still sign in: her dashboard shows who asked, and the request stops.
    const alicePage = await signedIn(browser, alice);
    await alicePage.goto(`/homes/${homeId}`);
    const notice = alicePage.getByTestId("recovery-owner-notice");
    await expect(notice).toContainText("Dave asked Madeora on");
    await expectNoAxeViolations(alicePage, "owner notice");
    await notice.getByRole("button", { name: "I still have access" }).click();
    await expect(
      alicePage.getByText("The request has ended. Nothing changes in your Home."),
    ).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("recovery-own-state")).toHaveText(
      "The Owner ended your request because they still have access. Contact them directly.",
    );
    await expect(page.getByRole("button", { name: "Accept ownership" })).toHaveCount(0);
  });
});
