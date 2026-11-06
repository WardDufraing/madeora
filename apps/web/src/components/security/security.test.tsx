import { AuthApiError } from "@supabase/supabase-js";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type * as GoogleReauth from "@/auth/google-reauth";

import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { PasswordSetting } from "./password-setting";
import { RecoveryCodes } from "./recovery-codes";
import { SessionsSetting, type SessionRow } from "./sessions-setting";
import { TwoFactorChallenge } from "./two-factor-challenge";

const browser = {
  rpc: vi.fn(),
  auth: {
    signOut: vi.fn(),
    refreshSession: vi.fn(),
    updateUser: vi.fn(),
    mfa: { challengeAndVerify: vi.fn() },
  },
};
vi.mock("@/auth/supabase-browser", () => ({
  getSupabaseBrowserClient: () => browser,
}));
const startGoogleReauth = vi.fn();
vi.mock("@/auth/google-reauth", async (importOriginal) => ({
  ...(await importOriginal<typeof GoogleReauth>()),
  startGoogleReauth: (...args: unknown[]) => startGoogleReauth(...args) as unknown,
}));
const fetchMock = vi.fn();
const reauthenticate = vi.fn();
vi.mock("@/auth/reauthenticate", () => ({
  reauthenticate: (...args: unknown[]) => reauthenticate(...args) as unknown,
}));

const assign = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  browser.auth.signOut.mockResolvedValue({ error: null });
  browser.auth.refreshSession.mockResolvedValue({ error: null });
  browser.auth.updateUser.mockResolvedValue({ error: null });
  browser.auth.mfa.challengeAndVerify.mockResolvedValue({ error: null });
  reauthenticate.mockResolvedValue(null);
  startGoogleReauth.mockResolvedValue({ error: null });
  fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("location", { origin: "http://localhost", assign });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function assignedPath(): string {
  const url = assign.mock.calls[0]?.[0] as URL | undefined;
  return url ? `${url.pathname}${url.search}` : "";
}

describe("TwoFactorChallenge", () => {
  it("verifies the authenticator code and opens the next page with a full load", async () => {
    const { container } = renderWithIntl(<TwoFactorChallenge factorId="f-1" next="/today" />);
    expect(await axeViolations(container)).toEqual([]);
    await userEvent.type(screen.getByLabelText(/^Code from your authenticator app/), "123 456");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(browser.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
      factorId: "f-1",
      code: "123456",
    });
    expect(assignedPath()).toBe("/today");
    // Trust is opt-in: nothing is trusted unless the box is ticked.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("trusts this browser after the code when the person ticks the box", async () => {
    renderWithIntl(<TwoFactorChallenge factorId="f-1" next="/today" />);
    const trust = screen.getByRole("checkbox", { name: /Trust this browser for 30 days/ });
    expect(trust).not.toBeChecked();
    await userEvent.click(trust);
    await userEvent.type(screen.getByLabelText(/^Code from your authenticator app/), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/me/trusted-device", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(assignedPath()).toBe("/today");
  });

  it("still signs in when trusting the browser fails", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    renderWithIntl(<TwoFactorChallenge factorId="f-1" next="/today" />);
    await userEvent.click(screen.getByRole("checkbox", { name: /Trust this browser/ }));
    await userEvent.type(screen.getByLabelText(/^Code from your authenticator app/), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(assignedPath()).toBe("/today");
  });

  it("refuses a malformed code without asking Supabase", async () => {
    renderWithIntl(<TwoFactorChallenge factorId="f-1" next="/today" />);
    await userEvent.type(screen.getByLabelText(/^Code from your authenticator app/), "12ab");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(browser.auth.mfa.challengeAndVerify).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^Code from your authenticator app/)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("shows a wrong code, clears it and stays on the page", async () => {
    browser.auth.mfa.challengeAndVerify.mockResolvedValue({
      error: new AuthApiError("Invalid TOTP code", 422, "mfa_verification_failed"),
    });
    renderWithIntl(<TwoFactorChallenge factorId="f-1" next="/today" />);
    const field = screen.getByLabelText(/^Code from your authenticator app/);
    await userEvent.type(field, "000000");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(field).toHaveValue("");
    expect(assign).not.toHaveBeenCalled();
  });

  it("redeems a recovery code, refreshes the session and opens Security", async () => {
    browser.rpc.mockResolvedValue({ data: "ok", error: null });
    renderWithIntl(<TwoFactorChallenge factorId="f-1" next="/today" />);
    await userEvent.click(screen.getByRole("button", { name: "Use a recovery code instead" }));
    await userEvent.type(screen.getByLabelText(/^Recovery code/), "abcd-efgh-jkmn");
    await userEvent.click(screen.getByRole("button", { name: "Sign in with recovery code" }));
    expect(browser.rpc).toHaveBeenCalledWith("redeem_two_factor_recovery_code", {
      p_code: "ABCDEFGHJKMN",
    });
    expect(browser.auth.refreshSession).toHaveBeenCalled();
    expect(assignedPath()).toBe("/settings/security?recovered=1");
  });

  it("says a used or wrong recovery code doesn't work", async () => {
    browser.rpc.mockResolvedValue({ data: "invalid", error: null });
    renderWithIntl(<TwoFactorChallenge factorId="f-1" next="/today" />);
    await userEvent.click(screen.getByRole("button", { name: "Use a recovery code instead" }));
    await userEvent.type(screen.getByLabelText(/^Recovery code/), "ABCD-EFGH-JKMN");
    await userEvent.click(screen.getByRole("button", { name: "Sign in with recovery code" }));
    expect(await screen.findByText(/That recovery code doesn't work/)).toBeVisible();
    expect(browser.auth.refreshSession).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("signs out instead", async () => {
    renderWithIntl(<TwoFactorChallenge factorId="f-1" next="/today" />);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(browser.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(assignedPath()).toBe("/sign-in?status=signed-out");
  });
});

const current: SessionRow = {
  id: "s-current",
  device: { kind: "computer", browser: "firefox", platform: "linux" },
  created: "1 Nov",
  lastActive: "now",
  isCurrent: true,
};
const other: SessionRow = {
  id: "s-other",
  device: { kind: "phone", browser: "safari", platform: "ios" },
  created: "2 Nov",
  lastActive: "yesterday",
  isCurrent: false,
};

describe("SessionsSetting", () => {
  it("lists sessions and offers no sign-out for this device", async () => {
    const { container } = renderWithIntl(<SessionsSetting sessions={[current, other]} />);
    expect(screen.getAllByTestId("session-row")).toHaveLength(2);
    expect(screen.getByText("This device")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Sign out Firefox on Linux" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out Safari on iPhone" })).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("signs out another session at once, without reauthentication", async () => {
    browser.rpc.mockResolvedValue({ data: true, error: null });
    renderWithIntl(<SessionsSetting sessions={[current, other]} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign out Safari on iPhone" }));
    expect(browser.rpc).toHaveBeenCalledWith("revoke_my_session", {
      p_session_id: "s-other",
      p_report: false,
    });
    expect(await screen.findByText("That session was signed out.")).toBeVisible();
    expect(screen.getAllByTestId("session-row")).toHaveLength(1);
    expect(reauthenticate).not.toHaveBeenCalled();
  });

  it("says when the session had already ended", async () => {
    browser.rpc.mockResolvedValue({ data: false, error: null });
    renderWithIntl(<SessionsSetting sessions={[current, other]} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign out Safari on iPhone" }));
    expect(await screen.findByText("That session had already ended.")).toBeVisible();
  });

  it("keeps the row when the database refuses", async () => {
    browser.rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    renderWithIntl(<SessionsSetting sessions={[current, other]} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign out Safari on iPhone" }));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.getAllByTestId("session-row")).toHaveLength(2);
  });

  it("reports a session after a confirmation", async () => {
    browser.rpc.mockResolvedValue({ data: true, error: null });
    renderWithIntl(<SessionsSetting sessions={[current, other]} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Report Safari on iPhone as suspicious" }),
    );
    expect(browser.rpc).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Sign out and report" }));
    expect(browser.rpc).toHaveBeenCalledWith("revoke_my_session", {
      p_session_id: "s-other",
      p_report: true,
    });
    expect(await screen.findByText("The session was signed out and reported.")).toBeVisible();
  });

  it("signs out everywhere after a confirmation, then leaves", async () => {
    browser.rpc.mockResolvedValue({ data: null, error: null });
    renderWithIntl(<SessionsSetting sessions={[current, other]} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    const dialog = screen.getByRole("dialog");
    expect(browser.rpc).not.toHaveBeenCalled();
    await userEvent.click(
      Array.from(dialog.querySelectorAll("button")).find(
        (button) => button.textContent === "Sign out everywhere",
      ) ?? dialog,
    );
    expect(browser.rpc).toHaveBeenCalledWith("sign_out_everywhere");
    expect(browser.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(assignedPath()).toBe("/sign-in?status=signed-out");
  });
});

describe("RecoveryCodes", () => {
  it("shows each code once and continues only after the person confirms saving them", async () => {
    const onDone = vi.fn();
    const codes = ["ABCD-EFGH-JKMN", "PQRS-TUVW-XYZ2"];
    const { container } = renderWithIntl(<RecoveryCodes codes={codes} onDone={onDone} />);
    expect(screen.getAllByTestId("recovery-code").map((item) => item.textContent)).toEqual(codes);
    expect(await axeViolations(container)).toEqual([]);
    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toBeDisabled();
    await userEvent.click(screen.getByLabelText("I've stored these codes somewhere safe"));
    await userEvent.click(done);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

const account = { email: "ada@example.test", userId: "user-a", confirmed: null };
const googleOnly = { email: "g@gmail.test", userId: "user-g" };

describe("PasswordSetting", () => {
  async function fill(withCode: boolean) {
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    await userEvent.type(screen.getByLabelText(/^Your current password/), "old password 1");
    if (withCode) {
      await userEvent.type(screen.getByLabelText(/^Code from your authenticator app/), "123456");
    }
    await userEvent.type(screen.getByLabelText(/^New password/), "a new long password 2");
    await userEvent.type(
      screen.getByLabelText(/^Repeat the new password/),
      "a new long password 2",
    );
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
  }

  it("reauthenticates, asks for the password permission, then changes the password", async () => {
    const { container } = renderWithIntl(<PasswordSetting {...account} twoFactor hasPassword />);
    await fill(true);
    expect(reauthenticate).toHaveBeenCalledWith(
      { email: "ada@example.test", password: "old password 1", code: "123456", captchaOptions: {} },
      expect.any(Function),
    );
    const authorize = reauthenticate.mock.calls[0]?.[1] as (
      client: unknown,
      sessionId: string,
    ) => unknown;
    const rpc = vi.fn();
    authorize({ rpc }, "main-session");
    expect(rpc).toHaveBeenCalledWith("authorize_account_change", {
      p_action: "password",
      p_session_id: "main-session",
    });
    expect(browser.auth.updateUser).toHaveBeenCalledWith({ password: "a new long password 2" });
    expect(await screen.findByText(/all other devices were signed out/)).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("changes nothing when reauthentication fails", async () => {
    reauthenticate.mockResolvedValue({
      step: "password",
      error: new AuthApiError("Invalid login credentials", 400, "invalid_credentials"),
    });
    renderWithIntl(<PasswordSetting {...account} twoFactor={false} hasPassword />);
    await fill(false);
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(browser.auth.updateUser).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^Your current password/)).toHaveValue("");
  });

  it("lets a Google-only account set a password after confirming with Google", async () => {
    renderWithIntl(
      <PasswordSetting {...googleOnly} twoFactor hasPassword={false} confirmed={null} />,
    );
    expect(screen.queryByRole("button", { name: "Change password" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Set a password" }));
    expect(startGoogleReauth).toHaveBeenCalledWith(
      { action: "password", userId: "user-g", twoFactor: true },
      "g@gmail.test",
    );
  });

  it("asks for nothing more once Google has confirmed the change", async () => {
    const { container } = renderWithIntl(
      <PasswordSetting
        {...googleOnly}
        twoFactor={false}
        hasPassword={false}
        confirmed="password"
      />,
    );
    expect(screen.queryByLabelText(/^Your current password/)).toBeNull();
    await userEvent.type(screen.getByLabelText(/^New password/), "a new long password 2");
    await userEvent.type(
      screen.getByLabelText(/^Repeat the new password/),
      "a new long password 2",
    );
    await userEvent.click(screen.getByRole("button", { name: "Set a password" }));
    expect(reauthenticate).not.toHaveBeenCalled();
    expect(browser.auth.updateUser).toHaveBeenCalledWith({ password: "a new long password 2" });
    expect(await screen.findByText(/Your password is set/)).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("ignores a Google confirmation meant for another change", () => {
    renderWithIntl(
      <PasswordSetting {...googleOnly} twoFactor={false} hasPassword={false} confirmed="email" />,
    );
    expect(screen.queryByLabelText(/^New password/)).toBeNull();
    expect(screen.getByRole("button", { name: "Set a password" })).toBeVisible();
  });
});
