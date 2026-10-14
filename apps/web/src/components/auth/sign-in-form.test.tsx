import { AuthApiError } from "@supabase/supabase-js";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Locale } from "@/i18n/locales";
import { renderWithIntl } from "@/test/intl";

import { SignInForm } from "./sign-in-form";

const signInWithPassword = vi.fn();
vi.mock("@/auth/supabase-browser", () => ({
  getSupabaseBrowserClient: () => ({ auth: { signInWithPassword } }),
  getMemoryOnlySupabaseClient: () => ({ auth: { resend: vi.fn() } }),
}));

const labels = {
  en: { email: /^Email address/, password: /^Password( \*)?$/, submit: "Sign in" },
  nl: { email: /^E-mailadres/, password: /^Wachtwoord( \*)?$/, submit: "Aanmelden" },
} as const;

async function signIn(locale: Locale) {
  renderWithIntl(<SignInForm next="/" />, locale);
  await userEvent.type(screen.getByLabelText(labels[locale].email), "ada@example.test");
  await userEvent.type(screen.getByLabelText(labels[locale].password), "whatever it is");
  await userEvent.click(screen.getByRole("button", { name: labels[locale].submit }));
}

beforeEach(() => {
  signInWithPassword.mockReset();
});

describe("SignInForm", () => {
  it.each([
    ["en", "invalid_credentials", 400, "The email address or password is incorrect."],
    ["nl", "invalid_credentials", 400, "Het e-mailadres of wachtwoord klopt niet."],
    ["en", "over_request_rate_limit", 429, "Too many attempts. Wait a few minutes and try again."],
    [
      "nl",
      "over_request_rate_limit",
      429,
      "Te veel pogingen. Wacht een paar minuten en probeer het opnieuw.",
    ],
  ] as const)("in %s, %s gives one generic message", async (locale, code, status, message) => {
    signInWithPassword.mockResolvedValue({ error: new AuthApiError("x", status, code) });
    await signIn(locale);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByLabelText(labels[locale].password)).toHaveValue("");
  });

  it("offers to resend the confirmation for an unconfirmed account", async () => {
    signInWithPassword.mockResolvedValue({
      error: new AuthApiError("x", 400, "email_not_confirmed"),
    });
    await signIn("en");
    expect(await screen.findByRole("button", { name: "Send the email again" })).toBeVisible();
  });

  it("names the missing fields and moves focus to the first one", async () => {
    renderWithIntl(<SignInForm next="/" />);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const email = screen.getByLabelText(/^Email address/);
    expect(email).toHaveFocus();
    expect(email).toHaveAccessibleDescription(expect.stringContaining("Enter your email address."));
    expect(signInWithPassword).not.toHaveBeenCalled();
  });
});
