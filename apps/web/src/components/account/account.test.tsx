import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  forgetAccount,
  listRememberedAccounts,
  MAX_REMEMBERED_ACCOUNTS,
  rememberAccount,
  rememberChoice,
  setRememberChoice,
} from "@/auth/remembered-accounts";
import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { AccountChooser } from "./account-chooser";
import { AccountMemory } from "./account-memory";
import { DeactivateAccount } from "./deactivate-account";
import { ReactivateAccount } from "./reactivate-account";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/auth/captcha", () => ({
  useCaptcha: () => ({ ready: true, options: undefined, check: null, reset: vi.fn() }),
}));
const reauthenticate = vi.fn();
vi.mock("@/auth/reauthenticate", () => ({
  reauthenticate: (...args: unknown[]) => reauthenticate(...args) as unknown,
}));

const fetchMock = vi.fn<typeof fetch>();
const assign = vi.fn();
const ANN = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";
const BEN = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f02";
const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f03";

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  reauthenticate.mockResolvedValue(null);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { assign, origin: "http://localhost:3000" });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remembered accounts", () => {
  it("keeps only names and colours, most recent first, within the limit", () => {
    rememberAccount({ userId: ANN, name: "Ann", accent: "#2563eb" });
    rememberAccount({ userId: BEN, name: null, accent: null });
    rememberAccount({ userId: ANN, name: "Ann B", accent: "#2563eb" });
    expect(listRememberedAccounts().map((entry) => entry.name)).toEqual(["Ann B", null]);
    for (let index = 0; index < MAX_REMEMBERED_ACCOUNTS + 2; index += 1) {
      rememberAccount({
        userId: `6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a1${String(index).padStart(3, "0")}`,
        name: `P${String(index)}`,
        accent: null,
      });
    }
    expect(listRememberedAccounts()).toHaveLength(MAX_REMEMBERED_ACCOUNTS);
    forgetAccount(BEN);
    expect(listRememberedAccounts().some((entry) => entry.userId === BEN)).toBe(false);
  });

  it("ignores anything unreadable or malformed", () => {
    window.localStorage.setItem("madeora.remembered-accounts.v1", "{not json");
    expect(listRememberedAccounts()).toEqual([]);
    window.localStorage.setItem(
      "madeora.remembered-accounts.v1",
      JSON.stringify([{ userId: ANN, name: "Ann", accent: null, token: "secret" }]),
    );
    expect(listRememberedAccounts()).toEqual([]);
  });

  it("remembers the signed-in account unless the person said not to", () => {
    const { unmount } = renderWithIntl(<AccountMemory userId={ANN} name="Ann" accent={null} />);
    expect(listRememberedAccounts()).toHaveLength(1);
    unmount();
    setRememberChoice(false);
    expect(rememberChoice()).toBe(false);
    // The choice holds in every tab of this browser, not only the one that signed in.
    expect(window.localStorage.getItem("madeora.remember-account")).toBe("no");
    renderWithIntl(<AccountMemory userId={ANN} name="Ann" accent={null} />);
    expect(listRememberedAccounts()).toEqual([]);
  });
});

describe("AccountChooser", () => {
  it("shows names only, marks the active account and switches through sign-out", async () => {
    rememberAccount({ userId: BEN, name: "Ben", accent: "#16a34a" });
    rememberAccount({ userId: ANN, name: "Ann", accent: "#2563eb" });
    const { container } = renderWithIntl(<AccountChooser activeUserId={ANN} />);
    const items = within(screen.getByRole("list", { name: "Remembered accounts" })).getAllByRole(
      "listitem",
    );
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText("Signed in now")).toBeInTheDocument();
    const switchButton = screen.getByRole("button", { name: "Switch to Ben" });
    const form = switchButton.closest("form");
    expect(form).toHaveAttribute("action", "/auth/sign-out");
    expect(within(form as HTMLFormElement).getByDisplayValue(BEN)).toHaveAttribute(
      "name",
      "account",
    );
    expect(container.textContent).not.toMatch(/@|Home/);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("removes another account from this device only", async () => {
    rememberAccount({ userId: BEN, name: "Ben", accent: null });
    renderWithIntl(<AccountChooser activeUserId={null} />);
    expect(screen.getByRole("link", { name: "Switch to Ben" })).toHaveAttribute(
      "href",
      `/sign-in?account=${BEN}`,
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove Ben from this device" }));
    await waitFor(() => {
      expect(screen.getByText("No accounts are remembered on this device.")).toBeInTheDocument();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("DeactivateAccount", () => {
  const props = {
    email: "ann@example.com",
    userId: ANN,
    twoFactor: false,
    hasPassword: true,
    confirmed: null,
    blockers: [],
  } as const;

  it("sends a sole Owner to transfer ownership first", () => {
    renderWithIntl(<DeactivateAccount {...props} blockers={[{ homeId: HOME, homeName: "Oak" }]} />);
    expect(screen.getByText("Oak")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Transfer ownership" })).toHaveAttribute(
      "href",
      `/homes/${HOME}/members`,
    );
    expect(screen.queryByRole("button", { name: "Deactivate my account" })).not.toBeInTheDocument();
  });

  it("asks to confirm, then to confirm it's you, then deactivates", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: "reauthentication-required" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({}));
    const { container } = renderWithIntl(<DeactivateAccount {...props} />);
    expect(await axeViolations(container)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Deactivate my account" }));
    expect(await screen.findByText(/Tick the box/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
    await userEvent.click(screen.getByRole("button", { name: "Deactivate my account" }));
    const confirm = await screen.findByRole("form", {
      name: "Confirm it's you to deactivate your account.",
    });
    await userEvent.type(within(confirm).getByLabelText(/password/i), "correct horse");
    await userEvent.click(within(confirm).getByRole("button", { name: "Deactivate my account" }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalled();
    });
    expect(String(assign.mock.calls[0]?.[0])).toContain("/sign-in?status=deactivated");
    expect(reauthenticate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/me/deactivate",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("says when a Home still needs another Owner", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "sole-owner" }, { status: 409 }));
    renderWithIntl(<DeactivateAccount {...props} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
    await userEvent.click(screen.getByRole("button", { name: "Deactivate my account" }));
    expect(await screen.findByText(/only Owner of a Home/)).toBeInTheDocument();
    expect(router.refresh).toHaveBeenCalled();
  });
});

describe("ReactivateAccount", () => {
  it("reactivates, then signs in afresh and shows what changed in the person's Homes", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ since: "2026-09-01T10:00:00+00:00" }));
    renderWithIntl(<ReactivateAccount />);
    await userEvent.click(screen.getByRole("button", { name: "Reactivate my account" }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalled();
    });
    const target = new URL(String(assign.mock.calls[0]?.[0]));
    expect(target.pathname).toBe("/sign-in");
    expect(target.searchParams.get("status")).toBe("reactivated");
    const next = new URL(target.searchParams.get("next") ?? "", target.origin);
    expect(next.pathname).toBe("/settings/activity");
    expect(next.searchParams.get("category")).toBe("home_memberships");
    expect(next.searchParams.get("from")).toBe("2026-09-01");
    expect(next.searchParams.get("welcome")).toBe("back");
  });

  it("says when reactivation failed", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "failed" }, { status: 500 }));
    renderWithIntl(<ReactivateAccount />);
    await userEvent.click(screen.getByRole("button", { name: "Reactivate my account" }));
    expect(await screen.findByText(/couldn't be reactivated/)).toBeInTheDocument();
  });
});
