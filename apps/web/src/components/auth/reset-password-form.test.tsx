import { AuthApiError } from "@supabase/supabase-js";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithIntl } from "@/test/intl";

import { ResetPasswordForm } from "./reset-password-form";

const auth = { verifyOtp: vi.fn(), updateUser: vi.fn(), signOut: vi.fn() };
vi.mock("@/auth/supabase-browser", () => ({ getMemoryOnlySupabaseClient: () => ({ auth }) }));

const tokenHash = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const assign = vi.fn();

beforeEach(() => {
  auth.verifyOtp.mockReset().mockResolvedValue({ error: null });
  auth.updateUser.mockReset().mockResolvedValue({ error: null });
  auth.signOut.mockReset().mockResolvedValue({ error: null });
  assign.mockReset();
  vi.stubGlobal("location", { assign, origin: "http://app.test" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function submit(password: string) {
  await userEvent.type(screen.getByLabelText(/^New password/), password);
  await userEvent.type(screen.getByLabelText(/^Repeat the new password/), password);
  await userEvent.click(screen.getByRole("button", { name: "Save new password" }));
}

describe("ResetPasswordForm", () => {
  it("uses the link only on submit, saves the password, then signs out every session", async () => {
    renderWithIntl(<ResetPasswordForm tokenHash={tokenHash} />);
    expect(auth.verifyOtp).not.toHaveBeenCalled();

    await submit("correct horse battery");

    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: tokenHash, type: "recovery" });
    expect(auth.updateUser).toHaveBeenCalledWith({ password: "correct horse battery" });
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(assign).toHaveBeenCalledWith(
      new URL("/sign-in?status=password-changed", "http://app.test"),
    );
  });

  it("never reports success when signing out everywhere fails, and offers a retry", async () => {
    auth.signOut.mockResolvedValueOnce({ error: new AuthApiError("down", 500, "unexpected") });
    renderWithIntl(<ResetPasswordForm tokenHash={tokenHash} />);
    await submit("correct horse battery");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your password was changed and your other devices were signed out, but this browser's reset",
    );
    expect(assign).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Sign out every device" }));
    expect(auth.signOut).toHaveBeenCalledTimes(2);
    expect(assign).toHaveBeenCalledOnce();
  });

  it("keeps the verified link for a second try after the new password is refused", async () => {
    auth.updateUser.mockResolvedValueOnce({
      error: new AuthApiError("same", 422, "same_password"),
    });
    renderWithIntl(<ResetPasswordForm tokenHash={tokenHash} />);
    await submit("correct horse battery");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a password that is different from your current one.",
    );

    await userEvent.clear(screen.getByLabelText(/^New password/));
    await userEvent.clear(screen.getByLabelText(/^Repeat the new password/));
    await submit("another correct horse");
    expect(auth.verifyOtp).toHaveBeenCalledOnce();
    expect(auth.updateUser).toHaveBeenCalledTimes(2);
    expect(assign).toHaveBeenCalledOnce();
  });

  it("explains an expired or used link, in Dutch too", async () => {
    auth.verifyOtp.mockResolvedValue({ error: new AuthApiError("expired", 403, "otp_expired") });
    renderWithIntl(<ResetPasswordForm tokenHash={tokenHash} />, "nl");
    await userEvent.type(screen.getByLabelText(/^Nieuw wachtwoord/), "correct horse battery");
    await userEvent.type(
      screen.getByLabelText(/^Herhaal het nieuwe wachtwoord/),
      "correct horse battery",
    );
    await userEvent.click(screen.getByRole("button", { name: "Nieuw wachtwoord opslaan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Deze link is verlopen of al gebruikt.",
    );
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("checks the rules before contacting Supabase", async () => {
    renderWithIntl(<ResetPasswordForm tokenHash={tokenHash} />);
    await submit("too short");
    expect(screen.getByLabelText(/^New password/)).toHaveAccessibleDescription(
      expect.stringContaining("Use at least 12 characters."),
    );
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it("says when the link is incomplete", () => {
    renderWithIntl(<ResetPasswordForm tokenHash={null} />);
    expect(screen.queryByRole("button", { name: "Save new password" })).toBeNull();
    expect(screen.getByRole("link", { name: /new link/i })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });
});
