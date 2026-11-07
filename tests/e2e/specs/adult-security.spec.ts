import type { Browser, Page } from "@playwright/test";

import { newAccount, registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { sql } from "../support/database";
import { e2eEnv } from "../support/env";
import { emailLink, waitForEmail } from "../support/mail";
import { readSession } from "../support/session";
import { totp } from "../support/totp";

// S37: adult account security. Every test makes its own synthetic account and starts signed out.
// A wrong code or a refused request is a 4xx that Chromium logs as a console error.
test.use({
  storageState: { cookies: [], origins: [] },
  allowedConsoleErrors: [
    /Failed to load resource: the server responded with a status of (400|401|403|422|429)/,
  ],
});

const subjects = {
  enrolled: "Two-factor sign-in was turned on for your Madeora account",
  passwordChanged: "Your Madeora password was changed",
  emailChange: "Confirm your new Madeora email address",
  emailChanged: "Your Madeora account email was changed",
} as const;

/**
 * The database refuses a second successful code for one authenticator within 90 seconds (replay
 * protection). Tests move earlier verifications back instead of waiting for the next code.
 */
function ageVerifications(email: string): void {
  sql(
    `update auth.mfa_challenges c set verified_at = c.verified_at - interval '5 minutes'
       from auth.mfa_factors f join auth.users u on u.id = f.user_id
      where c.factor_id = f.id and u.email = :'email' and c.verified_at is not null;`,
    { email },
  );
}

async function reauthenticate(page: Page, account: Account, secret?: string) {
  await page.getByLabel(/^Your current password/).fill(account.password);
  if (secret) {
    ageVerifications(account.email);
    await page.getByLabel(/^Code from your authenticator app/).fill(totp(secret));
  }
}

/** Turns two-factor sign-in on through Settings › Security; returns the authenticator secret. */
async function turnOnTwoFactor(
  page: Page,
  account: Account,
): Promise<{ secret: string; codes: string[] }> {
  await page.goto("/settings/security");
  await page.getByRole("button", { name: "Turn on two-factor sign-in" }).click();
  await reauthenticate(page, account);
  await page.getByRole("button", { name: "Continue" }).click();
  const secret = (await page.getByTestId("totp-secret").textContent())?.trim() ?? "";
  expect(secret).toMatch(/^[A-Z2-7]+=*$/);
  await expect(
    page.getByRole("img", { name: /QR code for setting up two-factor sign-in/ }),
  ).toBeVisible();
  await page.getByLabel(/^Code from your authenticator app/).fill(totp(secret));
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(page.getByTestId("recovery-codes")).toBeVisible();
  const codes = await page.getByTestId("recovery-code").allTextContents();
  expect(codes).toHaveLength(10);
  await page.getByLabel("I've stored these codes somewhere safe").check();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(/^Two-factor sign-in is on\./)).toBeVisible();
  return { secret, codes };
}

async function freshPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  return context.newPage();
}

async function signInWithPassword(page: Page, account: Account, path = "/sign-in") {
  await page.goto(path);
  await page.getByLabel("Email address").fill(account.email);
  await page.getByLabel(/^Password/).fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("two-factor sign-in", () => {
  test("turning it on asks every new sign-in for a code, before anything else", async ({
    page,
    browser,
    baseURL,
  }) => {
    const account = await registerConfirmed(baseURL ?? "");
    await signIn(page, account);
    const { secret } = await turnOnTwoFactor(page, account);
    await waitForEmail(account.email, subjects.enrolled);

    const other = await freshPage(browser);
    await signInWithPassword(other, account, "/sign-in?next=%2Fsettings");
    await expect(other).toHaveURL(/\/sign-in\/two-factor/);
    expect(await axeViolations(other)).toEqual([]);

    // Until the code is given, the app and the database refuse this session.
    await other.goto("/settings");
    await expect(other).toHaveURL(/\/sign-in\/two-factor/);
    const { session } = await readSession(other.context());
    const accessToken = typeof session.access_token === "string" ? session.access_token : "";
    const response = await fetch(`${e2eEnv.supabaseUrl}/rest/v1/rpc/my_account_security`, {
      method: "POST",
      headers: {
        apikey: e2eEnv.publishableKey,
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(401);

    await other.getByLabel(/^Code from your authenticator app/).fill("000000");
    await other.getByRole("button", { name: "Continue" }).click();
    // Wait for the refusal, which also empties the field, before typing the right code.
    await expect(other.getByText(/^That code is incorrect\./)).toBeVisible();
    await expect(other.getByLabel(/^Code from your authenticator app/)).toHaveValue("");

    ageVerifications(account.email);
    await other.getByLabel(/^Code from your authenticator app/).fill(totp(secret));
    await other.getByRole("button", { name: "Continue" }).click();
    await expect(other).toHaveURL(/\/settings$/);
    await other.context().close();
  });

  test("with two-factor sign-in on, changes need the password and a code", async ({
    page,
    baseURL,
  }) => {
    const account = await registerConfirmed(baseURL ?? "");
    await signIn(page, account);
    const { secret, codes } = await turnOnTwoFactor(page, account);

    await page.getByRole("button", { name: "New recovery codes" }).click();
    await reauthenticate(page, account, secret);
    await page.getByRole("button", { name: "Create new codes" }).click();
    await expect(page.getByTestId("recovery-codes")).toBeVisible();
    const fresh = await page.getByTestId("recovery-code").allTextContents();
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toEqual(codes);
    await page.getByLabel("I've stored these codes somewhere safe").check();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(
      page.getByText("New recovery codes are ready. The old ones no longer work."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Turn off", exact: true }).click();
    await reauthenticate(page, account, secret);
    await page.getByRole("button", { name: "Turn off two-factor sign-in" }).click();
    await expect(page.getByText(/^Two-factor sign-in is off\./)).toBeVisible();
  });

  test("a trusted browser skips the code until its trust is ended", async ({
    page,
    browser,
    baseURL,
  }) => {
    const account = await registerConfirmed(baseURL ?? "");
    await signIn(page, account);
    const { secret } = await turnOnTwoFactor(page, account);

    const other = await freshPage(browser);
    await signInWithPassword(other, account, "/sign-in?next=%2Fsettings");
    await expect(other).toHaveURL(/\/sign-in\/two-factor/);
    ageVerifications(account.email);
    await other.getByLabel(/^Code from your authenticator app/).fill(totp(secret));
    await other.getByRole("checkbox", { name: /Trust this browser for 30 days/ }).check();
    await other.getByRole("button", { name: "Continue" }).click();
    await expect(other).toHaveURL(/\/settings$/);
    const trust = (await other.context().cookies()).find((cookie) =>
      cookie.name.startsWith("madeora-trust-"),
    );
    expect(trust?.httpOnly).toBe(true);

    // A new sign-in in the same browser needs no code; the token stays aal1 and still works.
    await other.context().clearCookies({ name: /^sb-/ });
    await signInWithPassword(other, account, "/sign-in?next=%2Fsettings");
    await expect(other).toHaveURL(/\/settings$/);

    // Ending trust from another session asks this browser for the code again.
    await page.goto("/settings/security#trusted");
    await expect(page.getByTestId("trusted-row")).toHaveCount(1);
    await page.getByRole("button", { name: "Stop trusting all browsers" }).click();
    await expect(page.getByText("No trusted browsers.")).toBeVisible();
    await other.goto("/settings");
    await expect(other).toHaveURL(/\/sign-in\/two-factor/);
    await other.context().close();
  });

  test("a trusted browser confirms a change with the password and a code", async ({
    page,
    browser,
    baseURL,
  }) => {
    const account = await registerConfirmed(baseURL ?? "");
    await signIn(page, account);
    const { secret, codes } = await turnOnTwoFactor(page, account);

    const other = await freshPage(browser);
    await signInWithPassword(other, account, "/sign-in?next=%2Fsettings");
    ageVerifications(account.email);
    await other.getByLabel(/^Code from your authenticator app/).fill(totp(secret));
    await other.getByRole("checkbox", { name: /Trust this browser for 30 days/ }).check();
    await other.getByRole("button", { name: "Continue" }).click();
    await expect(other).toHaveURL(/\/settings$/);

    // A new sign-in skips the code, so this session has not passed two-factor sign-in itself.
    await other.context().clearCookies({ name: /^sb-/ });
    await signInWithPassword(other, account, "/sign-in?next=%2Fsettings%2Fsecurity");
    await expect(other).toHaveURL(/\/settings\/security$/);
    await other.getByRole("button", { name: "New recovery codes" }).click();
    await reauthenticate(other, account, secret);
    await other.getByRole("button", { name: "Create new codes" }).click();
    await expect(other.getByTestId("recovery-codes")).toBeVisible();
    expect(await other.getByTestId("recovery-code").allTextContents()).not.toEqual(codes);
    await other.context().close();

    // The session that turned two-factor sign-in on had passed it, so it is still signed in.
    await page.goto("/settings/security");
    await expect(page).toHaveURL(/\/settings\/security$/);
  });

  test("a recovery code works once and turns two-factor sign-in off", async ({
    page,
    browser,
    baseURL,
  }) => {
    const account = await registerConfirmed(baseURL ?? "");
    await signIn(page, account);
    const { codes } = await turnOnTwoFactor(page, account);

    const lost = await freshPage(browser);
    await signInWithPassword(lost, account);
    await expect(lost).toHaveURL(/\/sign-in\/two-factor/);
    // A click before the page has hydrated does nothing, so click until the field appears.
    await expect(async () => {
      await lost.getByRole("button", { name: "Use a recovery code instead" }).click();
      await expect(lost.getByLabel(/^Recovery code/)).toBeVisible({ timeout: 1_000 });
    }).toPass();
    await lost.getByLabel(/^Recovery code/).fill("AAAA-AAAA-AAAA");
    await lost.getByRole("button", { name: "Sign in with recovery code" }).click();
    await expect(lost.getByText(/That recovery code doesn't work/)).toBeVisible();

    await lost.getByLabel(/^Recovery code/).fill(codes[0]?.toLowerCase() ?? "");
    await lost.getByRole("button", { name: "Sign in with recovery code" }).click();
    await expect(lost).toHaveURL(/\/settings\/security\?recovered=1$/);
    await expect(lost.getByText(/your authenticator was removed/)).toBeVisible();
    await expect(lost.getByTestId("two-factor-setting").getByText("Off.")).toBeVisible();
    await lost.context().close();

    // Redeeming signed out every other session, the one that turned two-factor sign-in on too.
    await page.goto("/settings/security");
    await expect(page).toHaveURL(/\/sign-in/);
  });
});

test.describe("password and email", () => {
  test("changing the password keeps this session and signs out the others", async ({
    page,
    browser,
    baseURL,
  }) => {
    const account = await registerConfirmed(baseURL ?? "");
    await signIn(page, account);
    const other = await freshPage(browser);
    await signIn(other, account);

    await page.goto("/settings/security");
    await page.getByRole("button", { name: "Change password" }).click();
    await reauthenticate(page, account);
    const newPassword = `${account.password}-changed`;
    await page.getByLabel(/^New password/).fill(newPassword);
    await page.getByLabel(/^Repeat the new password/).fill(newPassword);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText(/all other devices were signed out/)).toBeVisible();
    await waitForEmail(account.email, subjects.passwordChanged);

    await page.reload();
    await expect(page).toHaveURL(/\/settings\/security$/);
    await other.goto("/settings");
    await expect(other).toHaveURL(/\/sign-in/);
    await other.context().close();
  });

  test("a wrong current password changes nothing", async ({ page, browser, baseURL }) => {
    const account = await registerConfirmed(baseURL ?? "");
    await signIn(page, account);
    await page.goto("/settings/security");
    await page.getByRole("button", { name: "Change password" }).click();
    await page.getByLabel(/^Your current password/).fill("not the password at all");
    await page.getByLabel(/^New password/).fill("a different long password 9");
    await page.getByLabel(/^Repeat the new password/).fill("a different long password 9");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("That password is incorrect.")).toBeVisible();

    // The old password still signs in.
    const fresh = await freshPage(browser);
    await signIn(fresh, account);
    await expect(fresh).not.toHaveURL(/\/sign-in/);
    await fresh.context().close();
  });

  test("the email changes only once the new address confirms it", async ({ page, baseURL }) => {
    const account = await registerConfirmed(baseURL ?? "");
    const next = newAccount().email;
    await signIn(page, account);
    await page.goto("/settings/security");
    await page.getByRole("button", { name: "Change email address" }).click();
    await page.getByLabel(/^New email address/).fill(next);
    await reauthenticate(page, account);
    await page.getByRole("button", { name: "Send confirmation link" }).click();
    await expect(page.getByText(/we've sent it a confirmation link/)).toBeVisible();

    // Still the old address until the link is opened, and opening it alone changes nothing.
    const link = await emailLink(next, subjects.emailChange);
    await page.goto(link.toString());
    await expect(page.getByText(`Current: ${account.email}`)).toHaveCount(0);
    await page.getByRole("button", { name: "Confirm new address" }).click();
    await expect(page.getByText(/Your account email has been changed/)).toBeVisible();
    await waitForEmail(account.email, subjects.emailChanged);

    await page.goto("/settings/security");
    await expect(page.getByText(`Current: ${next}`)).toBeVisible();
  });
});

test.describe("devices and sessions", () => {
  test("another session can be signed out at once, and sign out everywhere ends all", async ({
    page,
    browser,
    baseURL,
  }) => {
    const account = await registerConfirmed(baseURL ?? "");
    await signIn(page, account);
    const other = await freshPage(browser);
    await signIn(other, account);

    await page.goto("/settings/security");
    await expect(page.getByTestId("session-row")).toHaveCount(2);
    expect(await axeViolations(page)).toEqual([]);
    await page
      .getByTestId("session-row")
      .filter({ hasNot: page.getByText("This device") })
      .getByRole("button", { name: /^Sign out / })
      .click();
    await expect(page.getByText("That session was signed out.")).toBeVisible();
    await other.goto("/settings");
    await expect(other).toHaveURL(/\/sign-in/);
    await other.context().close();

    const third = await freshPage(browser);
    await signIn(third, account);
    await page.reload();
    await page.getByRole("button", { name: "Sign out everywhere" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Sign out everywhere" }).click();
    await expect(page).toHaveURL(/\/sign-in\?status=signed-out$/);
    await third.goto("/settings");
    await expect(third).toHaveURL(/\/sign-in/);
    await third.context().close();
  });
});
