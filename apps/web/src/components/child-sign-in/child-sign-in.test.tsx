import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { ChildSignInForm } from "./child-sign-in-form";
import { ChildSignInSettings, type ChildSignInSettingsView } from "./child-sign-in-settings";
import { HouseholdDevicesSetting } from "./household-devices-setting";
import { HouseholdPinSignIn } from "./household-pin-sign-in";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const fetchMock = vi.fn<typeof fetch>();
const assign = vi.fn();
const bodyOf = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown;
const answer = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const CHILD_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0031";
const SIBLING_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0032";
const DEVICE_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0041";

beforeEach(() => {
  fetchMock.mockReset();
  assign.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { assign, origin: "http://app.test" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
});

describe("ChildSignInForm", () => {
  it("signs in with a full page load and clears the password after a refusal", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValueOnce(answer(401, { error: "invalid-credentials" }));
    const { container } = renderWithQuery(<ChildSignInForm />);
    expect(await axeViolations(container)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter your username.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.type(screen.getByRole("textbox", { name: "Username" }), "mia");
    await user.type(screen.getByLabelText(/^Password/), "wrong-pass");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByText("That didn't work. Check what you typed and try again."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^Password/)).toHaveValue("");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/child-sign-in/password");
    expect(bodyOf(init)).toEqual({ username: "mia", password: "wrong-pass" });

    fetchMock.mockReturnValueOnce(answer(200, {}));
    await user.type(screen.getByLabelText(/^Password/), "right-pass");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(new URL("/child", "http://app.test"));
    });
  });

  it("explains a lock that only a guardian can lift", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValueOnce(answer(423, { error: "locked", until: null }));
    renderWithQuery(<ChildSignInForm />);
    await user.type(screen.getByRole("textbox", { name: "Username" }), "mia");
    await user.type(screen.getByLabelText(/^Password/), "whatever1");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByText(
        "Too many wrong tries. Ask your parent or guardian to unlock your sign-in.",
      ),
    ).toBeInTheDocument();
  });
});

describe("HouseholdPinSignIn", () => {
  const childrenOfHome = [
    { membershipId: CHILD_ID, name: "Mia", accentColor: "#16a34a" },
    { membershipId: SIBLING_ID, name: "Noor", accentColor: null },
  ];

  it("asks who is signing in, then sends only the chosen child and the PIN", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValueOnce(answer(401, { error: "invalid-credentials" }));
    const { container } = renderWithQuery(<HouseholdPinSignIn childrenOfHome={childrenOfHome} />);
    expect(screen.getByRole("heading", { name: "Who are you?" })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Noor" }));
    expect(screen.getByText("Signing in as Noor")).toBeInTheDocument();
    const pin = screen.getByLabelText("Your PIN");
    expect(pin).toHaveFocus();
    expect(await axeViolations(container)).toEqual([]);

    // Letters are dropped as they are typed.
    await user.type(pin, "4a8b2c7");
    expect(pin).toHaveValue("4827");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByText("That didn't work. Check what you typed and try again."),
    ).toBeInTheDocument();
    expect(pin).toHaveValue("");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/child-sign-in/pin");
    expect(bodyOf(init)).toEqual({ childMembershipId: SIBLING_ID, pin: "4827" });

    fetchMock.mockReturnValueOnce(answer(200, {}));
    await user.type(pin, "4829");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(new URL("/child", "http://app.test"));
    });
  });

  it("refuses a PIN of the wrong shape without asking the server, and Not me goes back", async () => {
    const user = userEvent.setup();
    renderWithQuery(<HouseholdPinSignIn childrenOfHome={childrenOfHome} />);
    await user.click(screen.getByRole("button", { name: "Mia" }));
    await user.type(screen.getByLabelText("Your PIN"), "12");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByText("That didn't work. Check what you typed and try again."),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Not me" }));
    expect(screen.getByRole("heading", { name: "Who are you?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mia" }));
    expect(screen.getByLabelText("Your PIN")).toHaveValue("");
  });

  it("says when the device is no longer approved", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValueOnce(answer(403, { error: "device-not-approved" }));
    renderWithQuery(<HouseholdPinSignIn childrenOfHome={childrenOfHome} />);
    await user.click(screen.getByRole("button", { name: "Mia" }));
    await user.type(screen.getByLabelText("Your PIN"), "4827");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByText("PIN sign-in is not available on this device."),
    ).toBeInTheDocument();
  });
});

describe("ChildSignInSettings", () => {
  const settings: ChildSignInSettingsView = {
    username: "mia",
    hasPassword: true,
    hasPin: true,
    passwordSignIn: false,
    pinSignIn: true,
    passwordLock: null,
    pinLock: "guardian",
    activeSessions: 1,
    canManageIdentity: true,
  };
  const endpoint = `/api/v1/homes/${HOME_ID}/children/${CHILD_ID}/sign-in`;

  it("lets the primary guardian set a PIN, which is sent once and cleared", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, { outcome: "saved" }));
    const { container } = renderWithQuery(
      <ChildSignInSettings
        homeId={HOME_ID}
        membershipId={CHILD_ID}
        childName="Mia"
        isPrimary
        settings={settings}
      />,
    );
    expect(screen.getByText(/It stays locked until a guardian unlocks it/)).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);

    const pin = screen.getByLabelText("New PIN");
    await user.type(pin, "1234");
    await user.click(screen.getByRole("button", { name: "Set PIN" }));
    expect(
      await screen.findByText(
        "This PIN is too easy to guess. Avoid repeating one digit or a simple run.",
      ),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.clear(pin);
    await user.type(pin, "4827");
    await user.click(screen.getByRole("button", { name: "Set PIN" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(endpoint);
    expect(bodyOf(init)).toEqual({ action: "pin", pin: "4827" });
    expect(pin).toHaveValue("");
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });

    await user.click(screen.getByRole("button", { name: "Unlock sign-in" }));
    await waitFor(() => {
      expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toEqual({ action: "unlock" });
    });
  });

  it("shows another guardian only what any guardian may do", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(answer(200, { outcome: "saved" }));
    renderWithQuery(
      <ChildSignInSettings
        homeId={HOME_ID}
        membershipId={CHILD_ID}
        childName="Mia"
        isPrimary={false}
        settings={settings}
      />,
    );
    expect(screen.queryByLabelText("Username", { selector: "input" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove password" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("New PIN")).toBeInTheDocument();
    expect(
      screen.getAllByText("Only the primary guardian can turn this on. You can turn it off."),
    ).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    await waitFor(() => {
      expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ action: "end-sessions" });
    });
  });

  it("keeps the identity-wide username and password from a primary guardian of only this Home", async () => {
    const { container } = renderWithQuery(
      <ChildSignInSettings
        homeId={HOME_ID}
        membershipId={CHILD_ID}
        childName="Mia"
        isPrimary
        settings={{ ...settings, canManageIdentity: false }}
      />,
    );
    expect(screen.getByTestId("identity-other-home")).toHaveTextContent(/also in another Home/);
    expect(screen.queryByLabelText(/^Username/, { selector: "input" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove password" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("New PIN")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign out on this Home's devices" }),
    ).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("HouseholdDevicesSetting", () => {
  it("approves this device under a name and revokes another", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((input) =>
      (typeof input === "string" ? input : "").endsWith("/revoke")
        ? answer(200, {})
        : answer(201, { device: { id: DEVICE_ID } }),
    );
    const { container } = renderWithQuery(
      <HouseholdDevicesSetting
        homeId={HOME_ID}
        devices={[
          {
            id: DEVICE_ID,
            label: "Kitchen tablet",
            approvedBy: "Alice",
            approvedAt: "12 Nov 2026",
            lastUsedAt: null,
            isThisDevice: false,
          },
        ]}
      />,
    );
    expect(await axeViolations(container)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Approve this device" }));
    expect(
      await screen.findByText("Enter a name of up to 60 visible characters."),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.type(screen.getByRole("textbox", { name: /Name for this device/ }), "Hall iPad");
    await user.click(screen.getByRole("button", { name: "Approve this device" }));
    expect(await screen.findByText("This device is approved for PIN sign-in.")).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/homes/${HOME_ID}/household-devices`);
    expect(bodyOf(init)).toEqual({ label: "Hall iPad" });

    await user.click(screen.getByRole("button", { name: "Revoke Kitchen tablet" }));
    expect(
      await screen.findByText("The device is revoked. Its PIN sessions have ended."),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/v1/homes/${HOME_ID}/household-devices/${DEVICE_ID}/revoke`,
    );
  });

  it("shows that this device is already approved instead of the form", () => {
    renderWithQuery(
      <HouseholdDevicesSetting
        homeId={HOME_ID}
        devices={[
          {
            id: DEVICE_ID,
            label: "Kitchen tablet",
            approvedBy: null,
            approvedAt: "12 Nov 2026",
            lastUsedAt: "today",
            isThisDevice: true,
          },
        ]}
      />,
    );
    expect(screen.queryByTestId("approve-device-form")).not.toBeInTheDocument();
    expect(
      screen.getByText("This device is approved. Children sign in with their PIN at /household."),
    ).toBeInTheDocument();
  });
});
