import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { e2eEnv } from "../support/env";
import { subjects, waitForEmail } from "../support/mail";
import { readSession } from "../support/session";

// S08: Google sign-in and sign-in method management. Supabase Auth runs its real Google code
// against the stand-in Google from tests/e2e/scripts/fake-google.ts, so these tests run only in
// `pnpm test:e2e:fallback` (here and in CI's "E2E Google sign-in" job). They start signed out.
// Chromium logs refused requests (a wrong password, a refused unlink) as console errors.
test.use({
  storageState: { cookies: [], origins: [] },
  allowedConsoleErrors: [
    /Failed to load resource: the server responded with a status of (400|422|500)/,
  ],
});

const dashboardHeading = (page: Page) =>
  page.getByRole("main").getByRole("heading", { level: 1, name: "Dashboard" });

/** A Google account email that belongs to no Madeora account yet. */
const newGoogleEmail = () => `g-${randomUUID()}@gmail.test`;

/** On the stand-in Google page: pick the Google account, or cancel. */
async function atGoogle(page: Page, choice: { email: string } | "cancel") {
  await expect(page.getByRole("heading", { name: "Stand-in Google sign-in" })).toBeVisible();
  if (choice === "cancel") {
    await page.getByRole("button", { name: "Cancel" }).click();
    return;
  }
  await page.getByLabel("Google account email").fill(choice.email);
  await page.getByRole("button", { name: "Continue" }).click();
}

async function signInWithGoogle(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await atGoogle(page, { email });
}

// The page's own alert (Next.js also keeps an empty route announcer with role "alert").
const alert = (page: Page) => page.getByRole("main").getByRole("alert");

const methods = (page: Page) => page.getByRole("region", { name: "Sign-in methods" });

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await page.waitForURL(/\/sign-in/);
}

/** Links Google from Settings, confirming with `password`. */
async function linkGoogle(page: Page, password: string, googleEmail: string) {
  await page.goto("/settings");
  await methods(page).getByRole("button", { name: "Link Google" }).click();
  await page.getByLabel(/^Your current password/).fill(password);
  await page.getByRole("button", { name: "Confirm and go to Google" }).click();
  await atGoogle(page, { email: googleEmail });
  await page.waitForURL(/\/settings/);
  await expect(page.getByText("Google is linked.", { exact: false })).toBeVisible();
}

test("a first Google sign-in creates one account and opens the personal dashboard", async ({
  page,
}) => {
  const googleEmail = newGoogleEmail();
  await signInWithGoogle(page, googleEmail);
  await expect(dashboardHeading(page)).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  // The account is a Google-only account: Google cannot be removed.
  await page.goto("/settings");
  await expect(methods(page).getByText(`Account email: ${googleEmail}`)).toBeVisible();
  await expect(methods(page).getByText("No password yet.")).toBeVisible();
  await expect(
    methods(page).getByText(`Linked to the Google account ${googleEmail}.`),
  ).toBeVisible();
  await expect(methods(page).getByText(/Google is your only way to sign in/)).toBeVisible();
  await expect(methods(page).getByRole("button", { name: "Unlink Google" })).toHaveCount(0);

  // Signing in again with the same Google account opens the same account.
  const { session: first } = await readSession(page.context());
  await signOut(page);
  await signInWithGoogle(page, googleEmail);
  await expect(dashboardHeading(page)).toBeVisible();
  const { session: second } = await readSession(page.context());
  expect((second.user as { id: string }).id).toBe((first.user as { id: string }).id);
});

test("Google is never attached to an existing account by a matching email", async ({
  page,
  baseURL,
}) => {
  const account = await registerConfirmed(baseURL ?? "");
  await signInWithGoogle(page, account.email);
  await expect(alert(page)).toContainText("Signing in with Google didn't work.");
  // The message is the same as for any other failure, with no word about an existing account.
  await expect(alert(page)).not.toContainText(account.email);
  await expect(page.getByRole("link", { name: "Back to sign in" })).toBeVisible();

  // Nothing was linked: the password account still has only its password.
  await signIn(page, account);
  await page.goto("/settings");
  await expect(methods(page).getByText("Not linked.")).toBeVisible();
});

test("a password account links Google after confirming its password, then signs in with either", async ({
  page,
  baseURL,
}) => {
  const account = await registerConfirmed(baseURL ?? "");
  const googleEmail = newGoogleEmail();
  await signIn(page, account);
  await page.goto("/settings");
  await methods(page).getByRole("button", { name: "Link Google" }).click();
  await expect(
    page.getByText(`Google will be linked to your Madeora account ${account.email}.`),
  ).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // A wrong password stops before Google.
  await page.getByLabel(/^Your current password/).fill("not the password at all");
  await page.getByRole("button", { name: "Confirm and go to Google" }).click();
  await expect(alert(page)).toHaveText("That password is incorrect.");
  await expect(page).toHaveURL(/\/settings/);

  await page.getByLabel(/^Your current password/).fill(account.password);
  await page.getByRole("button", { name: "Confirm and go to Google" }).click();
  // The reauthentication session is separate: the browser's own session is unchanged.
  await atGoogle(page, { email: googleEmail });
  await page.waitForURL(/\/settings/);
  await expect(page.getByRole("status").filter({ hasText: "Google is linked." })).toBeVisible();
  await expect(
    methods(page).getByText(`Linked to the Google account ${googleEmail}.`),
  ).toBeVisible();
  // The Madeora email stays the account's own, not Google's.
  await expect(methods(page).getByText(`Account email: ${account.email}`)).toBeVisible();
  // Supabase Auth tells the account's own address that a sign-in method was added.
  await waitForEmail(account.email, subjects.identityLinked);
  const { session: before } = await readSession(page.context());

  await signOut(page);
  await signInWithGoogle(page, googleEmail);
  await expect(dashboardHeading(page)).toBeVisible();
  const { session: viaGoogle } = await readSession(page.context());
  expect((viaGoogle.user as { id: string }).id).toBe((before.user as { id: string }).id);

  await signOut(page);
  await signIn(page, account);
  await expect(dashboardHeading(page)).toBeVisible();
});

/** Deletes an identity straight through Supabase Auth's API with this browser's session. */
async function unlinkThroughApi(page: Page): Promise<number> {
  const { session } = await readSession(page.context());
  const token = session.access_token as string;
  const user = (await (
    await fetch(`${e2eEnv.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: e2eEnv.publishableKey, authorization: `Bearer ${token}` },
    })
  ).json()) as { identities: { identity_id: string; provider: string }[] };
  const google = user.identities.find((identity) => identity.provider === "google");
  if (!google) throw new Error("no Google identity");
  const response = await fetch(
    `${e2eEnv.supabaseUrl}/auth/v1/user/identities/${google.identity_id}`,
    {
      method: "DELETE",
      headers: { apikey: e2eEnv.publishableKey, authorization: `Bearer ${token}` },
    },
  );
  return response.status;
}

test("the last sign-in method cannot be unlinked, and Google needs a fresh password to unlink", async ({
  page,
  baseURL,
}) => {
  // A Google-only account: the page offers no unlink, and Supabase Auth's API refuses it too.
  await signInWithGoogle(page, newGoogleEmail());
  await expect(dashboardHeading(page)).toBeVisible();
  expect(await unlinkThroughApi(page)).toBeGreaterThanOrEqual(400);
  await page.goto("/settings");
  await expect(methods(page).getByText(/Linked to the Google account/)).toBeVisible();
  await signOut(page);

  // A password account with Google: calling the API directly, without confirming the password,
  // is refused by the database; through Settings, with the password, it works.
  const account: Account = await registerConfirmed(baseURL ?? "");
  await signIn(page, account);
  await linkGoogle(page, account.password, newGoogleEmail());
  expect(await unlinkThroughApi(page)).toBeGreaterThanOrEqual(400);
  await page.reload();
  await expect(methods(page).getByText(/Linked to the Google account/)).toBeVisible();

  await methods(page).getByRole("button", { name: "Unlink Google" }).click();
  await expect(
    page.getByText(/After unlinking, you can no longer sign in with Google/),
  ).toBeVisible();
  await page.getByLabel(/^Your current password/).fill(account.password);
  await page.getByRole("button", { name: "Unlink Google" }).last().click();
  await page.waitForURL(/unlinked=google/);
  await expect(page.getByRole("status").filter({ hasText: "Google is unlinked." })).toBeVisible();
  await expect(methods(page).getByText("Not linked.")).toBeVisible();
  await waitForEmail(account.email, subjects.identityUnlinked);
  expect(await axeViolations(page)).toEqual([]);
});

test("cancelling at Google changes nothing", async ({ page, baseURL }) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await atGoogle(page, "cancel");
  await expect(page.getByRole("status")).toContainText("Signing in with Google was cancelled.");
  // The one-time code and error never stay in the address bar.
  await expect(page).toHaveURL(/\/auth\/callback$/);
  expect(await axeViolations(page)).toEqual([]);

  const account = await registerConfirmed(baseURL ?? "");
  await signIn(page, account);
  await page.goto("/settings");
  await methods(page).getByRole("button", { name: "Link Google" }).click();
  await page.getByLabel(/^Your current password/).fill(account.password);
  await page.getByRole("button", { name: "Confirm and go to Google" }).click();
  await atGoogle(page, "cancel");
  await expect(page.getByRole("status")).toContainText("Linking Google was cancelled.");
  await page.getByRole("link", { name: "Back to settings" }).click();
  await expect(methods(page).getByText("Not linked.")).toBeVisible();

  // The link permission from the confirmed password is still open, but a plain Google sign-in
  // with the account's email is not a link the account holder started: it is refused.
  await signOut(page);
  await signInWithGoogle(page, account.email);
  await expect(alert(page)).toContainText("Signing in with Google didn't work.");
  await signIn(page, account);
  await page.goto("/settings");
  await expect(methods(page).getByText("Not linked.")).toBeVisible();
});

test("a link that finishes after the browser switched accounts does not touch the new account", async ({
  page,
  baseURL,
}) => {
  const first = await registerConfirmed(baseURL ?? "");
  const second = await registerConfirmed(baseURL ?? "");
  await signIn(page, first);
  await page.goto("/settings");
  await methods(page).getByRole("button", { name: "Link Google" }).click();
  await page.getByLabel(/^Your current password/).fill(first.password);
  await page.getByRole("button", { name: "Confirm and go to Google" }).click();
  await expect(page.getByRole("heading", { name: "Stand-in Google sign-in" })).toBeVisible();

  // Meanwhile, someone else signs in on the same browser in another tab.
  const other = await page.context().newPage();
  await other.goto("/");
  await other.getByRole("button", { name: "Sign out" }).first().click();
  await other.waitForURL(/\/sign-in/);
  await signIn(other, second);
  await other.close();

  await atGoogle(page, { email: newGoogleEmail() });
  await expect(alert(page)).toContainText("This browser is now signed in to a different account");
  await page.goto("/settings");
  await expect(methods(page).getByText(`Account email: ${second.email}`)).toBeVisible();
  await expect(methods(page).getByText("Not linked.")).toBeVisible();
});
