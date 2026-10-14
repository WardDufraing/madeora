import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";

import { e2eEnv } from "./env";
import { emailLink, subjects } from "./mail";

export interface Account {
  readonly email: string;
  readonly password: string;
}

/** A new, never-used synthetic account. `.test` addresses can never receive real mail. */
export function newAccount(): Account {
  const id = randomUUID();
  return { email: `e2e-${id}@madeora.test`, password: `synthetic ${id.slice(0, 18)}` };
}

async function authApi(path: string, body: object): Promise<Response> {
  return fetch(`${e2eEnv.supabaseUrl}/auth/v1${path}`, {
    method: "POST",
    headers: { apikey: e2eEnv.publishableKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Registers through Supabase Auth's API (not the UI), leaving the email unconfirmed. */
export async function registerUnconfirmed(
  baseURL: string,
  account = newAccount(),
): Promise<Account> {
  const response = await authApi(
    `/signup?redirect_to=${encodeURIComponent(`${baseURL}/auth/confirm`)}`,
    account,
  );
  if (!response.ok)
    throw new Error(`sign-up failed: ${String(response.status)} ${await response.text()}`);
  return account;
}

/** Registers and confirms an account through the API and the real confirmation email. */
export async function registerConfirmed(baseURL: string): Promise<Account> {
  const account = await registerUnconfirmed(baseURL);
  const link = await emailLink(account.email, subjects.confirmation);
  const response = await authApi("/verify", {
    type: "signup",
    token_hash: link.searchParams.get("token_hash"),
  });
  if (!response.ok) throw new Error(`confirmation failed: ${String(response.status)}`);
  return account;
}

/** Signs in through the sign-in page and waits for the dashboard (or `next`). */
export async function signIn(page: Page, account: Account, path = "/sign-in"): Promise<void> {
  await page.goto(path);
  await page.getByLabel("Email address").fill(account.email);
  await page.getByLabel(/^Password/).fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
}
