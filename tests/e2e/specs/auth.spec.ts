import type { BrowserContext, Page } from "@playwright/test";

import {
  newAccount,
  registerConfirmed,
  registerUnconfirmed,
  signIn,
  type Account,
} from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { emailCount, emailLink, subjects } from "../support/mail";
import { e2eEnv } from "../support/env";

// S06: adult email/password accounts. These tests start signed out and make their own synthetic
// accounts. Chromium logs every failed request (a wrong password is a 400 from Supabase Auth) as
// a console error, so those lines are allowed here; every other console error still fails a test.
test.use({
  storageState: { cookies: [], origins: [] },
  allowedConsoleErrors: [
    /Failed to load resource: the server responded with a status of (400|401|403|422|429)/,
  ],
});

const dashboardHeading = (page: Page) =>
  page.getByRole("main").getByRole("heading", { level: 1, name: "Dashboard" });

async function fillNewPassword(page: Page, password: string) {
  await page.getByLabel(/^New password/).fill(password);
  await page.getByLabel(/^Repeat the new password/).fill(password);
}

/** The Supabase session cookie of `context`, decoded (`@supabase/ssr` format: `base64-` + JSON, maybe in chunks). */
async function readSession(
  context: BrowserContext,
): Promise<{ name: string; session: Record<string, unknown> }> {
  const cookies = (await context.cookies()).filter((cookie) =>
    /^sb-.+-auth-token(\.\d+)?$/.test(cookie.name),
  );
  if (cookies.length === 0) throw new Error("no session cookie");
  const name = (cookies[0]?.name ?? "").replace(/\.\d+$/, "");
  const value = cookies
    .sort((a, b) => Number(a.name.split(".").pop()) - Number(b.name.split(".").pop()))
    .map((cookie) => cookie.value)
    .join("");
  const json = Buffer.from(value.replace(/^base64-/, ""), "base64url").toString("utf8");
  return { name, session: JSON.parse(json) as Record<string, unknown> };
}

async function writeSession(
  context: BrowserContext,
  name: string,
  session: Record<string, unknown>,
) {
  const old = (await context.cookies()).filter((cookie) => cookie.name.startsWith(name));
  await context.clearCookies({ name: new RegExp(`^${name.replace(/[.-]/g, "\\$&")}(\\.\\d+)?$`) });
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  // Chunked like @supabase/ssr does, so long sessions still fit in cookies.
  const chunks = value.match(/.{1,3000}/g) ?? [];
  await context.addCookies(
    chunks.map((chunk, index) => ({
      name: chunks.length === 1 ? name : `${name}.${String(index)}`,
      value: chunk,
      domain: old[0]?.domain ?? "127.0.0.1",
      path: "/",
      sameSite: "Lax" as const,
    })),
  );
}

test.describe("registration and email confirmation", () => {
  test("register, confirm by email, sign out and sign in again", async ({ page, baseURL }) => {
    const account = newAccount();
    await page.goto("/sign-up");
    await expect(page).toHaveTitle("Create your account · Madeora");
    await page.getByLabel("Email address").fill(account.email);
    await page.getByLabel(/^Password/).fill(account.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeFocused();

    const link = await emailLink(account.email, subjects.confirmation);
    expect(link.origin).toBe(baseURL);
    expect(link.pathname).toBe("/auth/confirm");

    await page.goto(`${link.pathname}${link.search}`);
    await page.getByRole("button", { name: "Confirm my email address" }).click();
    await expect(dashboardHeading(page)).toBeVisible();
    // Personal context with zero Homes (spec: Home-independent onboarding).
    await expect(page.getByRole("group", { name: "Current context" })).toHaveText("Personal");

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in\?status=signed-out$/);
    await expect(page.getByText("You're signed out.")).toBeVisible();
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in$/);

    await signIn(page, account);
    await expect(dashboardHeading(page)).toBeVisible();
  });

  test("opening the confirmation link alone confirms nothing; the link works only once", async ({
    page,
    browser,
    baseURL,
  }) => {
    const account = await registerUnconfirmed(baseURL ?? "");
    const link = await emailLink(account.email, subjects.confirmation);

    // A mail scanner fetching the link does not use up the token.
    const scanner = await fetch(link);
    expect(scanner.status).toBe(200);
    await page.goto("/sign-in");
    await page.getByLabel("Email address").fill(account.email);
    await page.getByLabel(/^Password/).fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "Confirm your email address first",
    );

    await page.goto(`${link.pathname}${link.search}`);
    await page.getByRole("button", { name: "Confirm my email address" }).click();
    await expect(dashboardHeading(page)).toBeVisible();

    const other = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const second = await other.newPage();
    await second.goto(`${link.pathname}${link.search}`);
    await second.getByRole("button", { name: "Confirm my email address" }).click();
    await expect(second.getByRole("main").getByRole("alert")).toHaveText(
      "This link has expired or has already been used.",
    );
    await expect(second.getByRole("button", { name: "Send the email again" })).toBeVisible();
    await other.close();
  });

  test("an unconfirmed account can ask for the email again", async ({ page, baseURL }) => {
    const account = await registerUnconfirmed(baseURL ?? "");
    await page.goto("/sign-in");
    await page.getByLabel("Email address").fill(account.email);
    await page.getByLabel(/^Password/).fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "Confirm your email address first",
    );

    await expect.poll(() => emailCount(account.email)).toBe(1);
    // Supabase Auth sends at most one email per address per second (max_frequency in
    // supabase/config.toml); a faster resend is answered with "too many attempts".
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await page.getByRole("button", { name: "Send the email again" }).click();
    await expect(page.getByRole("main").getByRole("status")).toHaveText(
      "If an account with that address still needs confirming, we've sent a new link.",
    );
    await expect.poll(() => emailCount(account.email)).toBe(2);
  });

  test("a confirmation link without a token says so and offers a new one", async ({ page }) => {
    await page.goto("/auth/confirm?token_hash=not-a-token");
    await expect(page.getByText("This confirmation link is incomplete.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send the email again" })).toBeVisible();
  });

  test("the sign-up form explains each rule before contacting Supabase", async ({ page }) => {
    await page.goto("/sign-up");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByLabel("Email address")).toBeFocused();
    await expect(page.getByText("Enter your email address.")).toBeVisible();

    await page.getByLabel("Email address").fill("someone@madeora.test");
    await page.getByLabel(/^Password/).fill("short");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Use at least 12 characters.")).toBeVisible();
    await expect(page.getByLabel(/^Password/)).toHaveAttribute("aria-invalid", "true");

    await page.getByLabel(/^Password/).fill("someone@madeora.test");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Your password can't be your email address.")).toBeVisible();
  });
});

test.describe("password reset", () => {
  test("a reset signs out every session, the resetting browser included", async ({
    browser,
    baseURL,
  }) => {
    const account = await registerConfirmed(baseURL ?? "");
    const fresh = { storageState: { cookies: [], origins: [] } };

    // Two devices already signed in.
    const laptop = await browser.newContext(fresh);
    const laptopPage = await laptop.newPage();
    await signIn(laptopPage, account);
    const phone = await browser.newContext(fresh);
    const phonePage = await phone.newPage();
    await signIn(phonePage, account);

    // A third, signed-out browser asks for a reset.
    const resetting = await browser.newContext(fresh);
    const page = await resetting.newPage();
    await page.goto("/sign-in");
    await page.getByRole("link", { name: "Forgot your password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await page.getByLabel("Email address").fill(account.email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("main").getByRole("status")).toContainText(
      `If there's a Madeora account for ${account.email}`,
    );

    const link = await emailLink(account.email, subjects.recovery);
    expect(link.pathname).toBe("/reset-password");
    await page.goto(`${link.pathname}${link.search}`);
    const newPassword = `${account.password} renewed`;
    await fillNewPassword(page, newPassword);
    await page.getByRole("button", { name: "Save new password" }).click();
    await expect(page).toHaveURL(/\/sign-in\?status=password-changed$/);
    await expect(
      page.getByText("Your password has been changed and every device was signed out."),
    ).toBeVisible();

    // The resetting browser must sign in again; so must both earlier devices, on their next request.
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in$/);
    await laptopPage.reload();
    await expect(laptopPage).toHaveURL(/\/sign-in$/);
    await phonePage.goto("/settings");
    await expect(phonePage).toHaveURL(/\/sign-in\?next=%2Fsettings$/);

    // The old password no longer works; the new one does.
    await page.getByLabel("Email address").fill(account.email);
    await page.getByLabel(/^Password/).fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
      "The email address or password is incorrect.",
    );
    await signIn(page, { email: account.email, password: newPassword });
    await expect(dashboardHeading(page)).toBeVisible();

    // The reset link cannot be used a second time.
    const again = await browser.newContext(fresh);
    const againPage = await again.newPage();
    await againPage.goto(`${link.pathname}${link.search}`);
    await fillNewPassword(againPage, `${newPassword} again`);
    await againPage.getByRole("button", { name: "Save new password" }).click();
    await expect(againPage.getByRole("main").getByRole("alert")).toContainText(
      "This link has expired or has already been used.",
    );

    for (const context of [laptop, phone, resetting, again]) await context.close();
  });

  test("an unfinished reset does not sign the browser in", async ({ page, context, baseURL }) => {
    const account = await registerConfirmed(baseURL ?? "");
    await page.goto("/forgot-password");
    await page.getByLabel("Email address").fill(account.email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    const link = await emailLink(account.email, subjects.recovery);

    // Use the token, then fail the password update on purpose (same as the current one).
    await page.goto(`${link.pathname}${link.search}`);
    await fillNewPassword(page, account.password);
    await page.getByRole("button", { name: "Save new password" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
      "Choose a password that is different from your current one.",
    );

    // The reset session lives only in that page: the app still treats this browser as signed out.
    const other = await context.newPage();
    for (const path of ["/", "/settings"]) {
      await other.goto(path);
      await expect(other).toHaveURL(/\/sign-in(\?next=%2Fsettings)?$/);
    }
    expect((await context.cookies()).filter((cookie) => cookie.name.startsWith("sb-"))).toEqual([]);
    await other.close();

    // The same page can still finish the reset.
    await fillNewPassword(page, `${account.password} renewed`);
    await page.getByRole("button", { name: "Save new password" }).click();
    await expect(page).toHaveURL(/\/sign-in\?status=password-changed$/);
  });

  test("a reset link cannot be used to confirm an email address and sign in", async ({
    page,
    context,
    baseURL,
  }) => {
    const account = await registerConfirmed(baseURL ?? "");
    await page.goto("/forgot-password");
    await page.getByLabel("Email address").fill(account.email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    const link = await emailLink(account.email, subjects.recovery);

    await page.goto(`/auth/confirm${link.search.replace("type=recovery", "type=signup")}`);
    await page.getByRole("button", { name: "Confirm my email address" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "This link has expired or has already been used.",
    );
    expect((await context.cookies()).filter((cookie) => cookie.name.startsWith("sb-"))).toEqual([]);
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test("a reset page without a valid link says so", async ({ page }) => {
    await page.goto("/reset-password");
    await expect(page.getByText("This reset link is incomplete or has expired.")).toBeVisible();
    await page.getByRole("link", { name: "Ask for a new link" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
  });
});

test.describe("no account enumeration", () => {
  test("sign-up with an existing address looks exactly like a new one", async ({
    page,
    baseURL,
  }) => {
    const existing = await registerConfirmed(baseURL ?? "");
    await page.goto("/sign-up");
    await page.getByLabel("Email address").fill(existing.email);
    await page.getByLabel(/^Password/).fill("a different synthetic password");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect(
      page.getByText(`If ${existing.email} can be used for a new account`),
    ).toBeVisible();
  });

  test("Supabase Auth itself answers sign-up for an existing address like a new one", async ({
    request,
    baseURL,
  }) => {
    // The browser's network panel shows this answer, so the settings must not reveal accounts
    // either (supabase/config.toml: [auth.sms] enable_confirmations).
    const existing = await registerConfirmed(baseURL ?? "");
    const signUp = (email: string) =>
      request.post(`${e2eEnv.supabaseUrl}/auth/v1/signup`, {
        headers: { apikey: e2eEnv.publishableKey },
        data: { email, password: "a different synthetic password" },
      });
    const forExisting = await signUp(existing.email);
    const forNew = await signUp(newAccount().email);
    expect(forExisting.status()).toBe(200);
    expect(forNew.status()).toBe(200);
    const keys = async (response: typeof forNew) =>
      Object.keys((await response.json()) as object).sort();
    expect(await keys(forExisting)).toEqual(await keys(forNew));
  });

  test("a reset for an unknown address gets the same answer as for a real one", async ({
    page,
  }) => {
    const unknown = newAccount();
    await page.goto("/forgot-password");
    await page.getByLabel("Email address").fill(unknown.email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("main").getByRole("status")).toHaveText(
      `If there's a Madeora account for ${unknown.email}, we've sent it a link to choose a new password. The link works once and expires after an hour.`,
    );
  });

  test("wrong password and unknown address give the same error", async ({ page, baseURL }) => {
    const account = await registerConfirmed(baseURL ?? "");
    const attempts: Account[] = [
      { email: account.email, password: "not the right password" },
      { email: newAccount().email, password: "not the right password" },
    ];
    for (const attempt of attempts) {
      await page.goto("/sign-in");
      await page.getByLabel("Email address").fill(attempt.email);
      await page.getByLabel(/^Password/).fill(attempt.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByRole("main").getByRole("alert")).toHaveText(
        "The email address or password is incorrect.",
      );
      await expect(page.getByLabel(/^Password/)).toHaveValue("");
    }
  });

  test("Supabase's rate limit shows a wait-and-retry message", async ({ page }) => {
    await page.route("**/auth/v1/token**", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({
          code: "over_request_rate_limit",
          message: "Request rate limit reached",
        }),
      }),
    );
    const account = newAccount();
    await page.goto("/sign-in");
    await page.getByLabel("Email address").fill(account.email);
    await page.getByLabel(/^Password/).fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
      "Too many attempts. Wait a few minutes and try again.",
    );
  });
});

test.describe("access to the app", () => {
  test("a signed-out visit goes to sign-in and comes back afterwards", async ({
    page,
    baseURL,
  }) => {
    const account = await registerConfirmed(baseURL ?? "");
    await page.goto("/settings?tab=appearance");
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fsettings%3Ftab%3Dappearance$/);
    await page.getByLabel("Email address").fill(account.email);
    await page.getByLabel(/^Password/).fill(account.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/settings\?tab=appearance$/);

    // Signed in, the sign-in and sign-up pages lead back into the app.
    await page.goto("/sign-up");
    await expect(dashboardHeading(page)).toBeVisible();
  });

  test("a sign-in link cannot send anyone to another site", async ({ page, baseURL }) => {
    const account = await registerConfirmed(baseURL ?? "");
    for (const next of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
      await page.goto(`/sign-in?next=${encodeURIComponent(next)}`);
      await page.getByLabel("Email address").fill(account.email);
      await page.getByLabel(/^Password/).fill(account.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(dashboardHeading(page)).toBeVisible();
      expect(new URL(page.url()).origin).toBe(baseURL);
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page).toHaveURL(/\/sign-in\?status=signed-out$/);
    }
  });

  test("authenticated pages are never stored by shared caches", async ({ page, baseURL }) => {
    const account = await registerConfirmed(baseURL ?? "");
    await signIn(page, account);
    for (const path of ["/", "/settings", "/sign-in"]) {
      const response = await page.request.get(path, { maxRedirects: 0 });
      expect(response.headers()["cache-control"], path).toBe("private, no-store");
    }
  });

  test("a form used before the page is ready never puts the password in the address", async ({
    browser,
  }) => {
    // Without JavaScript the page stays as the server rendered it, as before hydration.
    const unready = await browser.newContext({
      javaScriptEnabled: false,
      storageState: { cookies: [], origins: [] },
    });
    const page = await unready.newPage();
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    const account = newAccount();
    const tokenHash = "ab".repeat(28);
    const forms = [
      { path: "/sign-in", submit: "Sign in", password: /^Password/ },
      { path: "/sign-up", submit: "Create account", password: /^Password/ },
      { path: "/forgot-password", submit: "Send reset link", password: null },
      {
        path: `/reset-password?token_hash=${tokenHash}`,
        submit: "Save new password",
        password: /^New password/,
      },
    ] as const;
    for (const form of forms) {
      await page.goto(form.path);
      const submit = page.getByRole("button", { name: form.submit });
      await expect(submit).toBeDisabled();
      // A form that still slipped through would post its fields, never put them in the address.
      await expect(page.locator("form").filter({ has: submit })).toHaveAttribute("method", "post");
      if (form.password) await page.getByLabel(form.password).fill(account.password);
      else await page.getByLabel("Email address").fill(account.email);
      await page.keyboard.press("Enter");
      await submit.click({ force: true });
    }
    await page.goto("/sign-in"); // Settles any navigation a submit could have started.
    for (const url of requested) {
      expect(url).not.toContain("password=");
      expect(url).not.toContain("email=");
    }
    await unready.close();
  });
});

test.describe("sessions", () => {
  test("an expiring session is refreshed by the server", async ({ page, context, baseURL }) => {
    const account = await registerConfirmed(baseURL ?? "");
    await signIn(page, account);
    const { name, session } = await readSession(context);
    // Leave the tokens intact but mark the session as expired: the next request must refresh it.
    await writeSession(context, name, {
      ...session,
      expires_at: Math.floor(Date.now() / 1000) - 60,
    });

    const response = await page.goto("/settings");
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole("main").getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeVisible();
    // A refresh always issues a new refresh token (the access token can be identical when it
    // happens within the same second as the sign-in) and a future expiry time.
    const refreshed = await readSession(context);
    expect(refreshed.session.refresh_token).not.toBe(session.refresh_token);
    expect(refreshed.session.expires_at).toBeGreaterThan(Date.now() / 1000);
  });

  test("an expired session that cannot be refreshed means signing in again", async ({
    page,
    context,
    baseURL,
  }) => {
    const account = await registerConfirmed(baseURL ?? "");
    await signIn(page, account);
    const { name, session } = await readSession(context);
    await writeSession(context, name, {
      ...session,
      expires_at: Math.floor(Date.now() / 1000) - 60,
      refresh_token: "synthetic-unusable-refresh-token",
    });
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fsettings$/);
  });

  test("a forged access token is refused", async ({ page, context, baseURL }) => {
    const account = await registerConfirmed(baseURL ?? "");
    await signIn(page, account);
    const { name, session } = await readSession(context);
    const [header, payload] = String(session.access_token).split(".");
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...claims, exp: Number(claims.exp) + 86_400 }),
    ).toString("base64url");
    await writeSession(context, name, {
      ...session,
      access_token: `${header ?? ""}.${forgedPayload}.c2lnbmF0dXJl`,
      expires_at: Math.floor(Date.now() / 1000) + 86_400,
    });
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test("sign-out refuses cross-site requests (CSRF) and works from the app", async ({
    page,
    baseURL,
  }) => {
    const account = await registerConfirmed(baseURL ?? "");
    await signIn(page, account);

    for (const headers of [{ Origin: "https://evil.example" }, { Origin: "null" }, {}]) {
      const response = await page.request.post("/auth/sign-out", { headers, maxRedirects: 0 });
      expect(response.status(), JSON.stringify(headers)).toBe(403);
    }
    await page.reload();
    await expect(dashboardHeading(page)).toBeVisible();

    const response = await page.request.post("/auth/sign-out", {
      headers: { Origin: baseURL ?? "" },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe("/sign-in?status=signed-out");
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test("signing out in one tab signs out the others at once", async ({ context, baseURL }) => {
    const account = await registerConfirmed(baseURL ?? "");
    const first = await context.newPage();
    await signIn(first, account);
    const second = await context.newPage();
    await second.goto("/settings");
    await expect(
      second.getByRole("main").getByRole("heading", { level: 1, name: "Settings" }),
    ).toBeVisible();
    // Wait until the second tab is interactive (hydrated), so it is listening for sign-outs.
    await second.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(second.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

    await first.getByRole("button", { name: "Sign out" }).click();
    await expect(first).toHaveURL(`${baseURL ?? ""}/sign-in?status=signed-out`);
    // The other tab is told straight away and asks the server again, which sends it to sign-in.
    await expect(second).toHaveURL(/\/sign-in\?next=%2Fsettings$/);
  });
});

test.describe("accessibility", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`auth pages have no axe violations (${theme})`, async ({ page, context }) => {
      await context.addCookies([{ name: "md-theme", value: theme, url: "http://127.0.0.1" }]);
      for (const path of [
        "/sign-in",
        "/sign-up",
        "/forgot-password",
        "/reset-password",
        "/auth/confirm",
      ]) {
        await page.goto(path);
        expect(await axeViolations(page), path).toEqual([]);
      }
      // Error states too.
      await page.goto("/sign-up");
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(page.getByText("Enter your email address.")).toBeVisible();
      expect(await axeViolations(page), "sign-up errors").toEqual([]);
    });
  }

  test("auth pages are in Dutch for a Dutch browser", async ({ browser }) => {
    const dutch = await browser.newContext({
      locale: "nl-BE",
      storageState: { cookies: [], origins: [] },
    });
    const page = await dutch.newPage();
    await page.goto("/sign-in");
    await expect(page).toHaveTitle("Aanmelden · Madeora");
    await expect(page.getByLabel("E-mailadres")).toBeVisible();
    await page.getByRole("button", { name: "Aanmelden" }).click();
    await expect(page.getByText("Vul je e-mailadres in.")).toBeVisible();
    await dutch.close();
  });
});
