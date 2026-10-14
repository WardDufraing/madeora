import { AuthApiError } from "@supabase/supabase-js";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithIntl } from "@/test/intl";

import { SignUpForm } from "./sign-up-form";

const auth = { signUp: vi.fn(), resend: vi.fn() };
vi.mock("@/auth/supabase-browser", () => ({ getMemoryOnlySupabaseClient: () => ({ auth }) }));
vi.mock("@/auth/email-links", () => ({ emailLinkTarget: () => "http://app.test/auth/confirm" }));

const email = "someone@madeora.test";

beforeEach(() => {
  auth.signUp.mockReset().mockResolvedValue({ error: null });
  auth.resend.mockReset().mockResolvedValue({ error: null });
});

async function signUp() {
  renderWithIntl(<SignUpForm />);
  await userEvent.type(screen.getByLabelText(/^Email address/), email);
  await userEvent.type(screen.getByLabelText(/^Password/), "a synthetic password");
  await userEvent.click(screen.getByRole("button", { name: "Create account" }));
}

describe("SignUpForm: no account enumeration", () => {
  it.each([
    ["a new address", null],
    [
      "an address Auth says is registered",
      new AuthApiError("User already registered", 422, "user_already_exists"),
    ],
    [
      "an address that was just sent an email",
      new AuthApiError("wait", 429, "over_email_send_rate_limit"),
    ],
  ])("answers %s with check your email", async (_name, error) => {
    auth.signUp.mockResolvedValueOnce({ error });
    await signUp();
    expect(await screen.findByRole("heading", { name: "Check your email" })).toHaveFocus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("still shows errors that say nothing about the address", async () => {
    auth.signUp.mockResolvedValueOnce({
      error: new AuthApiError("slow down", 429, "over_request_rate_limit"),
    });
    await signUp();
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts.");
  });

  it("answers a resend inside the email interval like a sent email", async () => {
    await signUp();
    auth.resend.mockResolvedValueOnce({
      error: new AuthApiError("wait", 429, "over_email_send_rate_limit"),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Send the email again" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "If an account with that address still needs confirming, we've sent a new link.",
    );
  });
});
