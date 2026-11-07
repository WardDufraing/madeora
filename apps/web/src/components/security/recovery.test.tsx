import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type * as GoogleReauth from "@/auth/google-reauth";

import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import {
  ContinueAccountRecovery,
  FinishAccountRecovery,
  StartAccountRecovery,
} from "./account-recovery";
import { AccountRecoveryCodesSetting } from "./account-recovery-codes-setting";
import { BackupEmailSetting } from "./backup-email-setting";
import { ConfirmBackupEmail } from "./confirm-backup-email";
import { RecoveryBanner } from "./recovery-banner";
import { TrustedDevicesSetting, type TrustedDeviceRow } from "./trusted-devices-setting";

const browser = { rpc: vi.fn() };
const recovery = { rpc: vi.fn() };
vi.mock("@/auth/supabase-browser", () => ({
  getSupabaseBrowserClient: () => browser,
  getMemoryOnlySupabaseClient: (purpose: string) => {
    if (purpose !== "account-recovery") throw new Error(`unexpected purpose ${purpose}`);
    return recovery;
  },
}));
const reauthenticate = vi.fn();
vi.mock("@/auth/reauthenticate", () => ({
  reauthenticate: (...args: unknown[]) => reauthenticate(...args) as unknown,
}));
const startGoogleReauth = vi.fn();
vi.mock("@/auth/google-reauth", async (importOriginal) => ({
  ...(await importOriginal<typeof GoogleReauth>()),
  startGoogleReauth: (...args: unknown[]) => startGoogleReauth(...args) as unknown,
}));

const assign = vi.fn();
const TOKEN = "a".repeat(43);

beforeEach(() => {
  vi.resetAllMocks();
  reauthenticate.mockResolvedValue(null);
  startGoogleReauth.mockResolvedValue({ error: null });
  vi.stubGlobal("location", { origin: "http://localhost", assign });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function assignedPath(): string {
  const url = assign.mock.calls[0]?.[0] as URL | undefined;
  return url ? `${url.pathname}${url.search}${url.hash}` : "";
}

function authorizeCall(): { action: unknown; session: unknown } {
  const authorize = reauthenticate.mock.calls[0]?.[1] as (client: unknown, id: string) => unknown;
  const rpc = vi.fn();
  authorize({ rpc }, "main-session");
  const args = rpc.mock.calls[0]?.[1] as { p_action: unknown; p_session_id: unknown };
  return { action: args.p_action, session: args.p_session_id };
}

const withPassword = {
  email: "ada@example.test",
  userId: "user-a",
  twoFactor: false,
  hasPassword: true,
  confirmed: null,
};

describe("BackupEmailSetting", () => {
  it("reauthenticates, then sends a link to the new backup address", async () => {
    browser.rpc.mockResolvedValue({ data: "sent", error: null });
    const { container } = renderWithIntl(
      <BackupEmailSetting {...withPassword} backupEmail={null} pendingBackupEmail={null} />,
    );
    expect(screen.getByText("No backup address yet.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Add a backup address" }));
    await userEvent.type(screen.getByLabelText(/^Backup email address/), "ada@backup.test");
    await userEvent.type(screen.getByLabelText(/^Your current password/), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Send link" }));
    expect(authorizeCall()).toEqual({ action: "backup_email", session: "main-session" });
    expect(browser.rpc).toHaveBeenCalledWith("request_backup_email", {
      p_email: "ada@backup.test",
    });
    expect(await screen.findByText(/Link sent/)).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("sends nothing when reauthentication fails", async () => {
    reauthenticate.mockResolvedValue({ step: "password", error: null });
    renderWithIntl(
      <BackupEmailSetting {...withPassword} backupEmail={null} pendingBackupEmail={null} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add a backup address" }));
    await userEvent.type(screen.getByLabelText(/^Backup email address/), "ada@backup.test");
    await userEvent.type(screen.getByLabelText(/^Your current password/), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Send link" }));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(browser.rpc).not.toHaveBeenCalled();
  });

  it("refuses the sign-in address as the backup address", async () => {
    browser.rpc.mockResolvedValue({ data: "same_as_primary", error: null });
    renderWithIntl(
      <BackupEmailSetting {...withPassword} backupEmail={null} pendingBackupEmail={null} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add a backup address" }));
    await userEvent.type(screen.getByLabelText(/^Backup email address/), "ADA@example.test");
    await userEvent.type(screen.getByLabelText(/^Your current password/), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Send link" }));
    expect(await screen.findByText("Use an address other than your sign-in email.")).toBeVisible();
  });

  it("removes the backup address after reauthentication", async () => {
    browser.rpc.mockResolvedValue({ data: true, error: null });
    renderWithIntl(
      <BackupEmailSetting
        {...withPassword}
        backupEmail="a•••@backup.test"
        pendingBackupEmail={null}
      />,
    );
    expect(screen.getByText("Backup address: a•••@backup.test")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Remove backup address" }));
    await userEvent.type(screen.getByLabelText(/^Your current password/), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Remove backup address" }));
    expect(browser.rpc).toHaveBeenCalledWith("remove_backup_email");
    expect(assignedPath()).toBe("/settings/security?backup=removed#recovery");
  });

  it("cancels a pending address without reauthentication", async () => {
    browser.rpc.mockResolvedValue({ data: null, error: null });
    renderWithIntl(
      <BackupEmailSetting {...withPassword} backupEmail={null} pendingBackupEmail="n•••@x.test" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel this address" }));
    expect(browser.rpc).toHaveBeenCalledWith("cancel_backup_email_change");
    expect(reauthenticate).not.toHaveBeenCalled();
  });

  it("confirms with Google first for an account without a password", async () => {
    renderWithIntl(
      <BackupEmailSetting
        {...withPassword}
        hasPassword={false}
        backupEmail={null}
        pendingBackupEmail={null}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add a backup address" }));
    expect(startGoogleReauth).toHaveBeenCalledWith(
      { action: "backup_email", userId: "user-a", twoFactor: false },
      "ada@example.test",
    );
  });
});

describe("AccountRecoveryCodesSetting", () => {
  it("creates codes after reauthentication and shows them once", async () => {
    browser.rpc.mockResolvedValue({ data: ["AAAA-BBBB-CCCC-DDDD"], error: null });
    renderWithIntl(
      <AccountRecoveryCodesSetting {...withPassword} codesLeft={0} hasBackupEmail={false} />,
    );
    expect(screen.getByText("They only work together with a backup address.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Create account recovery codes" }));
    await userEvent.type(screen.getByLabelText(/^Your current password/), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Create account recovery codes" }));
    expect(authorizeCall()).toEqual({ action: "account_recovery_codes", session: "main-session" });
    expect(browser.rpc).toHaveBeenCalledWith("create_account_recovery_codes");
    expect(await screen.findByText("AAAA-BBBB-CCCC-DDDD")).toBeVisible();
  });
});

const trustedRow: TrustedDeviceRow = {
  id: "d-1",
  device: { kind: "computer", browser: "firefox", platform: "linux" },
  trusted: "1 Nov",
  expires: "1 Dec",
  isCurrent: true,
};

describe("TrustedDevicesSetting", () => {
  it("ends one browser's trust without reauthentication", async () => {
    browser.rpc.mockResolvedValue({ data: true, error: null });
    const { container } = renderWithIntl(<TrustedDevicesSetting devices={[trustedRow]} />);
    expect(await axeViolations(container)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Stop trusting Firefox on Linux" }));
    expect(browser.rpc).toHaveBeenCalledWith("revoke_trusted_device", { p_device_id: "d-1" });
    expect(await screen.findByText("No trusted browsers.")).toBeVisible();
    expect(reauthenticate).not.toHaveBeenCalled();
  });

  it("ends all trust at once", async () => {
    browser.rpc.mockResolvedValue({ data: 1, error: null });
    renderWithIntl(<TrustedDevicesSetting devices={[trustedRow]} />);
    await userEvent.click(screen.getByRole("button", { name: "Stop trusting all browsers" }));
    expect(browser.rpc).toHaveBeenCalledWith("revoke_all_trusted_devices");
  });
});

describe("RecoveryBanner", () => {
  it("lets the signed-in owner stop a recovery at once", async () => {
    browser.rpc.mockResolvedValue({ data: true, error: null });
    const { container } = renderWithIntl(
      <RecoveryBanner waitingUntil="9 Nov, 10:00" ready={false} />,
    );
    expect(screen.getByText(/after 9 Nov, 10:00/)).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Stop the recovery" }));
    expect(browser.rpc).toHaveBeenCalledWith("cancel_account_recovery");
    expect(assignedPath()).toBe("/settings/security?recovery=cancelled");
  });
});

describe("ConfirmBackupEmail", () => {
  it("confirms only when the button is selected", async () => {
    browser.rpc.mockResolvedValue({ data: "confirmed", error: null });
    renderWithIntl(<ConfirmBackupEmail token={TOKEN} />);
    expect(browser.rpc).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirm backup address" }));
    expect(browser.rpc).toHaveBeenCalledWith("confirm_backup_email", { p_token: TOKEN });
    expect(await screen.findByText("Your backup address is confirmed.")).toBeVisible();
  });

  it("explains a used or expired link", async () => {
    browser.rpc.mockResolvedValue({ data: "invalid", error: null });
    renderWithIntl(<ConfirmBackupEmail token={TOKEN} />);
    await userEvent.click(screen.getByRole("button", { name: "Confirm backup address" }));
    expect(await screen.findByText(/This link doesn't work any more/)).toBeVisible();
  });
});

describe("Account recovery (signed out)", () => {
  it("starts with the sign-in address and never says whether it has an account", async () => {
    recovery.rpc.mockResolvedValue({ data: null, error: null });
    const { container } = renderWithIntl(<StartAccountRecovery />);
    expect(await axeViolations(container)).toEqual([]);
    await userEvent.type(screen.getByLabelText(/^Sign-in email address/), "ada@example.test");
    await userEvent.click(screen.getByRole("button", { name: "Send recovery link" }));
    expect(recovery.rpc).toHaveBeenCalledWith("start_account_recovery", {
      p_email: "ada@example.test",
    });
    expect(await screen.findByText(/If that account has a backup address/)).toBeVisible();
  });

  it("continues with an account recovery code and shows when the wait ends", async () => {
    recovery.rpc.mockResolvedValue({
      data: [{ outcome: "waiting", ready_at: "2026-11-09T10:00:00.000Z" }],
      error: null,
    });
    const { container } = renderWithIntl(<ContinueAccountRecovery token={TOKEN} />);
    expect(await axeViolations(container)).toEqual([]);
    await userEvent.type(screen.getByLabelText(/^Account recovery code/), "aaaa-bbbb-cccc-dddd");
    await userEvent.click(screen.getByLabelText(/I also lost my authenticator app/));
    await userEvent.click(screen.getByRole("button", { name: "Start the waiting period" }));
    expect(recovery.rpc).toHaveBeenCalledWith("continue_account_recovery", {
      p_token: TOKEN,
      p_code: "AAAABBBBCCCCDDDD",
      p_lost_authenticator: true,
    });
    expect(await screen.findByText(/The waiting period has started/)).toBeVisible();
  });

  it("refuses a malformed code without asking the database", async () => {
    renderWithIntl(<ContinueAccountRecovery token={TOKEN} />);
    await userEvent.type(screen.getByLabelText(/^Account recovery code/), "ABCD-EFGH-JKMN");
    await userEvent.click(screen.getByRole("button", { name: "Start the waiting period" }));
    expect(recovery.rpc).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a 16-character account recovery code.")).toBeVisible();
  });

  it("says a wrong code or link doesn't work", async () => {
    recovery.rpc.mockResolvedValue({ data: [{ outcome: "invalid", ready_at: null }], error: null });
    renderWithIntl(<ContinueAccountRecovery token={TOKEN} />);
    await userEvent.type(screen.getByLabelText(/^Account recovery code/), "AAAA-BBBB-CCCC-DDDD");
    await userEvent.click(screen.getByRole("button", { name: "Start the waiting period" }));
    expect(await screen.findByText(/That didn't work/)).toBeVisible();
  });

  it("shows a missing or malformed link as expired", () => {
    renderWithIntl(<ContinueAccountRecovery token={null} />);
    expect(screen.getByText(/This link doesn't work any more/)).toBeVisible();
  });

  it("finishes only when the button is selected, then points to a new password", async () => {
    recovery.rpc.mockResolvedValue({ data: "completed", error: null });
    renderWithIntl(<FinishAccountRecovery token={TOKEN} />);
    expect(recovery.rpc).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Finish recovery" }));
    expect(recovery.rpc).toHaveBeenCalledWith("finish_account_recovery", { p_token: TOKEN });
    expect(await screen.findByRole("link", { name: "Set a new password" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });
});
