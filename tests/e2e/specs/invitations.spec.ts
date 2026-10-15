import type { Browser, Page } from "@playwright/test";

import { newAccount, registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { sql } from "../support/database";
import { runJobs } from "../support/jobs";
import { emailLink } from "../support/mail";

// S10: the "Join Home" journey. An Owner invites by email, link or join code; the invited person
// signs in, sees the Home and the role, and asks to join; the Owner approves or declines. Each
// test makes its own accounts and Home, and each person has their own browser context.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 800 },
});

// The subject isolates the Home's name (FSI … PDI), so tests match the fixed part; each address is new.
// Each journey signs up several people and walks the whole flow, so it gets more than the default
// 30 seconds when the full suite runs in parallel.
test.describe.configure({ timeout: 90_000 });

const invitationSubject = "You're invited to join";

/** A new adult, signed in in their own browser context. */
async function person(browser: Browser, baseURL: string | undefined) {
  const account = await registerConfirmed(baseURL ?? "");
  const context = await browser.newContext({
    baseURL: baseURL ?? "",
    locale: "en-GB",
    timezoneId: "Europe/London",
  });
  const page = await context.newPage();
  await signIn(page, account);
  return { account, page };
}

/** Creates a Home through the form; returns its id. */
async function createHome(page: Page, name: string): Promise<string> {
  await page.goto("/homes/new");
  await page.getByRole("textbox", { name: /Home name/ }).fill(name);
  await page.getByRole("button", { name: "Create Home" }).click();
  await page.waitForURL(/\/homes\/[0-9a-f-]{36}$/);
  return page.url().split("/").pop() ?? "";
}

/** The link in the invitation email: the email goes out through a background job, so run the jobs first. */
async function invitationLink(email: string): Promise<URL> {
  runJobs();
  return emailLink(email, invitationSubject);
}

async function inviteByEmail(page: Page, homeId: string, email: string) {
  await page.goto(`/homes/${homeId}/invitations`);
  await page.getByRole("textbox", { name: /Email address/ }).fill(email);
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(
    page.getByRole("heading", { name: `Invitation on its way to ${email}.` }),
  ).toBeVisible();
}

/** Creates an invitation link (one person, or `maxUses` people); returns its address. */
async function createLink(page: Page, homeId: string, maxUses = 1): Promise<string> {
  await page.goto(`/homes/${homeId}/invitations`);
  await page.getByRole("radio", { name: /Invitation link/ }).check();
  if (maxUses > 1) {
    await page.getByRole("radio", { name: /Several people/ }).check();
    await page.getByRole("spinbutton", { name: /Number of people/ }).fill(String(maxUses));
  }
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.getByRole("heading", { name: "Invitation link created" })).toBeVisible();
  return page.getByRole("textbox", { name: "Link to share" }).inputValue();
}

async function askToJoin(page: Page, url: string, home: string) {
  await page.goto(url);
  await expect(page.getByRole("heading", { name: new RegExp(`join .?${home}`) })).toBeVisible();
  await page.getByRole("button", { name: /Accept invitation|Ask to join/ }).click();
  await expect(page.getByRole("heading", { name: "Request sent" })).toBeVisible();
}

async function decide(page: Page, homeId: string, who: Account, decision: "Approve" | "Decline") {
  await page.goto(`/homes/${homeId}/invitations`);
  const row = page.getByTestId("join-request-row").filter({ hasText: who.email });
  await row.getByRole("button", { name: decision }).click();
  if (decision === "Decline") {
    await page
      .getByRole("dialog", { name: "Decline this request?" })
      .getByRole("button", { name: "Decline request" })
      .click();
    await expect(page.getByText(/You declined the request/)).toBeVisible();
  } else {
    await expect(page.getByText(/is now a member of this Home/)).toBeVisible();
  }
}

async function expectRole(page: Page, homeId: string, role: string) {
  await page.goto(`/homes/${homeId}`);
  await expect(page.getByTestId("home-role")).toHaveText(new RegExp(role));
}

test("an emailed invitation: the invitee signs in, asks to join, and becomes a Member once approved", async ({
  browser,
  baseURL,
}) => {
  const owner = await person(browser, baseURL);
  const homeId = await createHome(owner.page, "Thuis");

  // The address has no account yet when the invitation goes out.
  const invitee = newAccount();
  await inviteByEmail(owner.page, homeId, invitee.email);
  const row = owner.page.getByTestId("invitation-row").filter({ hasText: invitee.email });
  // Queued with the invitation; a background job sends it and records the outcome.
  await expect(row.getByTestId("invitation-delivery")).toHaveText("Sending");

  const link = await invitationLink(invitee.email);
  expect(link.pathname).toMatch(/^\/join\//);
  await owner.page.reload();
  await expect(row.getByTestId("invitation-delivery")).toHaveText("Sent");

  // They create the account, then open the invitation: sign-in first, then back to it.
  const registered = await registerConfirmed(baseURL ?? "", invitee);
  const context = await browser.newContext({ baseURL: baseURL ?? "" });
  const page = await context.newPage();
  await signIn(page, registered, link.pathname);
  await page.waitForURL(`**${link.pathname}`);
  await expect(page.getByRole("heading", { name: /You're invited to join .?Thuis/ })).toBeVisible();
  await expect(page.getByTestId("join-role")).toHaveText("Member");

  // Keyboard only.
  const accept = page.getByRole("button", { name: "Accept invitation" });
  await accept.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Request sent" })).toBeFocused();

  // Asking is not joining.
  await page.goto(`/homes/${homeId}`);
  await expect(page.getByText("That Home isn't available to you.")).toBeVisible();
  await page.goto("/homes/join");
  await expect(page.getByTestId("my-join-request-state")).toHaveText("Waiting for approval");

  // The Owner sees the request on the dashboard link and approves it.
  await owner.page.goto(`/homes/${homeId}`);
  await expect(owner.page.getByTestId("invite-people-link")).toHaveText(/1 request waiting/);
  await decide(owner.page, homeId, registered, "Approve");

  await expectRole(page, homeId, "Member");
  await page.goto(link.pathname);
  await expect(page.getByRole("heading", { name: "You're already a member" })).toBeVisible();
});

test("a link for two people admits two, and the third finds it used up", async ({
  browser,
  baseURL,
}) => {
  const owner = await person(browser, baseURL);
  const homeId = await createHome(owner.page, "Kot");
  const url = await createLink(owner.page, homeId, 2);

  const first = await person(browser, baseURL);
  const second = await person(browser, baseURL);
  await askToJoin(first.page, url, "Kot");
  await askToJoin(second.page, url, "Kot");
  await decide(owner.page, homeId, first.account, "Approve");
  await decide(owner.page, homeId, second.account, "Approve");
  await expectRole(first.page, homeId, "Member");
  await expectRole(second.page, homeId, "Member");

  await owner.page.goto(`/homes/${homeId}/invitations`);
  const row = owner.page.getByTestId("invitation-row").first();
  await expect(row.getByTestId("invitation-state")).toHaveText("Used up");
  await expect(row).toContainText("2 of 2 used, 0 left");

  const third = await person(browser, baseURL);
  await third.page.goto(url);
  await expect(
    third.page.getByRole("heading", { name: "This invitation has been used" }),
  ).toBeVisible();
  await expect(third.page.getByRole("button", { name: "Accept invitation" })).toHaveCount(0);
});

test("a join code typed under Join a Home, declined by the Owner", async ({ browser, baseURL }) => {
  const owner = await person(browser, baseURL);
  const homeId = await createHome(owner.page, "Ons huis");
  await owner.page.goto(`/homes/${homeId}/invitations`);
  await owner.page.getByRole("radio", { name: /Join code/ }).check();
  await owner.page.getByRole("button", { name: "Create join code" }).click();
  const code =
    (await owner.page
      .getByText(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/)
      .first()
      .textContent()) ?? "";
  expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);

  const applicant = await person(browser, baseURL);
  await applicant.page.goto("/homes/join");
  await applicant.page.getByRole("textbox", { name: /Join code/ }).fill(code.toLowerCase());
  await applicant.page.getByRole("button", { name: "Continue" }).click();
  await expect(
    applicant.page.getByRole("heading", { name: /Ask to join .?Ons huis/ }),
  ).toBeVisible();
  await applicant.page.getByRole("button", { name: "Ask to join" }).click();
  await expect(applicant.page.getByRole("heading", { name: "Request sent" })).toBeVisible();

  await decide(owner.page, homeId, applicant.account, "Decline");

  await applicant.page.goto("/homes/join");
  await expect(applicant.page.getByTestId("my-join-request-state")).toHaveText("Declined");
  await applicant.page.goto(`/join/${code}`);
  await expect(
    applicant.page.getByRole("heading", { name: "Your request was declined" }),
  ).toBeVisible();
});

test("expired and revoked invitations show their state and cannot be used", async ({
  browser,
  baseURL,
}) => {
  const owner = await person(browser, baseURL);
  const homeId = await createHome(owner.page, "Thuis");
  const expiring = await createLink(owner.page, homeId);
  const revoking = await createLink(owner.page, homeId);

  // Time passes (set in the database: nobody waits a day in a test).
  sql(
    `update private.home_invitations set expires_at = now() - interval '1 minute'
     where token = :'token';`,
    { token: decodeURIComponent(expiring.split("/join/")[1] ?? "") },
  );

  await owner.page.goto(`/homes/${homeId}/invitations`);
  const active = owner.page
    .getByTestId("invitation-row")
    .filter({ has: owner.page.getByRole("button", { name: "Revoke" }) });
  await expect(active).toHaveCount(1);
  await active.getByRole("button", { name: "Revoke" }).click();
  await owner.page
    .getByRole("dialog", { name: "Revoke this invitation?" })
    .getByRole("button", { name: "Revoke invitation" })
    .click();
  await expect(owner.page.getByText(/Invitation revoked/)).toBeVisible();
  const states = owner.page.getByTestId("invitation-state");
  await expect(states).toHaveText(["Revoked", "Expired"]);

  const visitor = await person(browser, baseURL);
  await visitor.page.goto(expiring);
  await expect(
    visitor.page.getByRole("heading", { name: "This invitation has expired" }),
  ).toBeVisible();
  await visitor.page.goto(revoking);
  await expect(
    visitor.page.getByRole("heading", { name: "This invitation was withdrawn" }),
  ).toBeVisible();
  await expect(visitor.page.getByRole("button", { name: /Accept|Ask to join/ })).toHaveCount(0);
});

test("a person withdraws their own request", async ({ browser, baseURL }) => {
  const owner = await person(browser, baseURL);
  const homeId = await createHome(owner.page, "Thuis");
  const url = await createLink(owner.page, homeId);

  const applicant = await person(browser, baseURL);
  await askToJoin(applicant.page, url, "Thuis");
  await applicant.page.goto("/homes/join");
  await applicant.page.getByRole("button", { name: "Withdraw" }).click();
  await expect(applicant.page.getByText("Request withdrawn.")).toBeVisible();
  await expect(applicant.page.getByTestId("my-join-request-state")).toHaveText("Withdrawn");

  await owner.page.goto(`/homes/${homeId}/invitations`);
  await expect(owner.page.getByText("No one is waiting for approval.")).toBeVisible();
});

test("a forwarded email invitation is refused for another account, without showing the address", async ({
  browser,
  baseURL,
}) => {
  const owner = await person(browser, baseURL);
  const homeId = await createHome(owner.page, "Thuis");
  const invitee = await registerConfirmed(baseURL ?? "");
  await inviteByEmail(owner.page, homeId, invitee.email);
  const link = await invitationLink(invitee.email);

  const other = await person(browser, baseURL);
  await other.page.goto(link.pathname);
  await expect(
    other.page.getByRole("heading", { name: "This invitation is for another account" }),
  ).toBeVisible();
  await expect(other.page.getByText(invitee.email)).toHaveCount(0);
  await expect(other.page.getByText("Thuis")).toHaveCount(0);
});

test("renewing an email invitation sends a new link and kills the old one", async ({
  browser,
  baseURL,
}) => {
  const owner = await person(browser, baseURL);
  const homeId = await createHome(owner.page, "Thuis");
  const invitee = await registerConfirmed(baseURL ?? "");
  await inviteByEmail(owner.page, homeId, invitee.email);
  const oldLink = await invitationLink(invitee.email);

  // Sends are limited to one a minute; move the first one back rather than wait.
  sql(
    `update private.home_invitations set last_sent_at = now() - interval '2 minutes'
     where recipient_email = :'email';`,
    { email: invitee.email },
  );
  await owner.page.goto(`/homes/${homeId}/invitations`);
  await owner.page.getByRole("button", { name: "Renew" }).click();
  const dialog = owner.page.getByRole("dialog", { name: "Renew this invitation?" });
  await expect(dialog).toContainText(/valid until \d{2}\/\d{2}\/\d{4}/);
  await dialog.getByRole("button", { name: "Renew and send" }).click();
  await expect(owner.page.getByText(/A new link is on its way to/)).toBeVisible();

  await expect
    .poll(async () => (await invitationLink(invitee.email)).pathname)
    .not.toBe(oldLink.pathname);
  const newLink = await invitationLink(invitee.email);

  const context = await browser.newContext({ baseURL: baseURL ?? "" });
  const page = await context.newPage();
  await signIn(page, invitee);
  await page.goto(oldLink.pathname);
  await expect(page.getByRole("heading", { name: "This link or code doesn't work" })).toBeVisible();
  await page.goto(newLink.pathname);
  await expect(page.getByRole("button", { name: "Accept invitation" })).toBeVisible();
});

test("inviting an address with an account and one without gives the same answer", async ({
  browser,
  baseURL,
}) => {
  const owner = await person(browser, baseURL);
  const homeId = await createHome(owner.page, "Thuis");
  const existing = await registerConfirmed(baseURL ?? "");
  const unknown = newAccount();

  const answers: unknown[] = [];
  owner.page.on("response", async (response) => {
    if (
      response.url().endsWith(`/homes/${homeId}/invitations`) &&
      response.request().method() === "POST"
    ) {
      const body = (await response.json()) as { invitation: Record<string, unknown> };
      answers.push({
        status: response.status(),
        keys: Object.keys(body.invitation).sort(),
        delivery: body.invitation.delivery,
        url: body.invitation.url,
        code: body.invitation.code,
      });
    }
  });
  await inviteByEmail(owner.page, homeId, existing.email);
  await inviteByEmail(owner.page, homeId, unknown.email);
  await expect.poll(() => answers.length).toBe(2);
  expect(answers[0]).toEqual(answers[1]);
  expect(answers[0]).toMatchObject({ status: 201, delivery: "pending", url: null, code: null });
});

test("the invitation pages are accessible in both themes", async ({ browser, baseURL }) => {
  const owner = await person(browser, baseURL);
  const homeId = await createHome(owner.page, "Thuis");
  const url = await createLink(owner.page, homeId);
  const applicant = await person(browser, baseURL);
  await askToJoin(applicant.page, url, "Thuis");

  for (const theme of ["light", "dark"] as const) {
    await owner.page.goto(`/homes/${homeId}/invitations`);
    await owner.page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    expect(await axeViolations(owner.page), `invite people, ${theme}`).toEqual([]);

    for (const path of [new URL(url).pathname, "/homes/join"]) {
      await applicant.page.goto(path);
      await applicant.page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      expect(await axeViolations(applicant.page), `${path}, ${theme}`).toEqual([]);
    }
  }
});

test("a Member of the Home is not offered the invitation page", async ({ browser, baseURL }) => {
  const owner = await person(browser, baseURL);
  const homeId = await createHome(owner.page, "Thuis");
  const url = await createLink(owner.page, homeId);
  const member = await person(browser, baseURL);
  await askToJoin(member.page, url, "Thuis");
  await decide(owner.page, homeId, member.account, "Approve");

  await member.page.goto(`/homes/${homeId}`);
  await expect(member.page.getByTestId("invite-people-link")).toHaveCount(0);
  await member.page.goto(`/homes/${homeId}/invitations`);
  await expect(member.page.getByText("Not available", { exact: true })).toBeVisible();
  await expect(
    member.page.getByRole("button", { name: /Send invitation|Create link/ }),
  ).toHaveCount(0);
});
