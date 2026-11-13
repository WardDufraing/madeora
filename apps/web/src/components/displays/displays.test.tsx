import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { DisplayPairing } from "./display-pairing";
import { HouseholdDisplaysManager, type HouseholdDisplayView } from "./household-displays-manager";
import { PairedDisplay } from "./paired-display";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const fetchMock = vi.fn<typeof fetch>();
const replace = vi.fn();
const bodyOf = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown;
const answer = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const REQUEST_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0061";
const DISPLAY_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0071";

const words = {
  kind: { tablet: "Tablet", unknown: "Device" },
  browser: { safari: "Safari", other: "A browser" },
  platform: { ipados: "iPad", other: "an unknown device" },
};

beforeEach(() => {
  fetchMock.mockReset();
  replace.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { replace, origin: "http://app.test" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  router.refresh.mockClear();
});

describe("DisplayPairing", () => {
  it("shows only the instructions and the code, then a new code on request", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockReturnValueOnce(
        answer(200, { status: "pending", code: "ABCDEFGH", expiresAt: "2026-11-12T20:10:00Z" }),
      )
      .mockReturnValueOnce(
        answer(200, { status: "pending", code: "JKMNPQRS", expiresAt: "2026-11-12T20:20:00Z" }),
      );
    const { container } = renderWithQuery(<DisplayPairing />);
    expect(await screen.findByTestId("pairing-code")).toHaveTextContent("ABCD-EFGH");
    expect(screen.getByText("Pairing code: A B C D E F G H")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ renew: false });

    await user.click(screen.getByRole("button", { name: "Get a new code" }));
    expect(await screen.findByText("JKMN-PQRS")).toBeInTheDocument();
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toEqual({ renew: true });
  });

  it("asks again every few seconds and reloads into the display once approved", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock
      .mockReturnValueOnce(
        answer(200, { status: "pending", code: "ABCDEFGH", expiresAt: "2026-11-12T20:10:00Z" }),
      )
      .mockReturnValueOnce(answer(200, { status: "paired" }));
    renderWithQuery(<DisplayPairing />);
    expect(await screen.findByTestId("pairing-code")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/display");
    });
  });

  it("explains an expired code", async () => {
    fetchMock.mockReturnValueOnce(answer(200, { status: "expired" }));
    renderWithQuery(<DisplayPairing />);
    expect(
      await screen.findByText("This code has expired. Get a new code to try again."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("pairing-code")).not.toBeInTheDocument();
  });
});

describe("PairedDisplay", () => {
  it("shows the display's name, its Home and the time, and nothing else", async () => {
    const { container } = renderWithQuery(
      <PairedDisplay displayName="Keuken" homeName="Thuis" timeZone="Europe/Brussels" />,
    );
    expect(screen.getByRole("heading", { name: "Thuis" })).toBeInTheDocument();
    expect(screen.getByText("Household Display: Keuken")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("clears the screen and returns to pairing when the server no longer accepts it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock
      .mockReturnValueOnce(answer(401, { error: "not-paired" }))
      .mockReturnValueOnce(answer(200, {}));
    renderWithQuery(
      <PairedDisplay displayName="Keuken" homeName="Thuis" timeZone="Europe/Brussels" />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/display");
    });
    expect(screen.queryByText("Thuis")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/display/reset");
  });

  it("says it is offline and keeps the same harmless screen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    renderWithQuery(
      <PairedDisplay displayName="Keuken" homeName="Thuis" timeZone="Europe/Brussels" />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(await screen.findByText(/^Offline\./)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Thuis" })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});

const active: HouseholdDisplayView = {
  id: DISPLAY_ID,
  name: "Keuken",
  active: true,
  device: "Tablet: Safari on iPad",
  pairedAt: "12 Nov 2026, 20:00",
  pairedBy: "Alice",
  lastSeenAt: null,
  revokedAt: null,
};

describe("HouseholdDisplaysManager", () => {
  it("checks the code, shows the device for review, then approves it under a name", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockReturnValueOnce(
        answer(200, {
          request: {
            id: REQUEST_ID,
            deviceKind: "tablet",
            browser: "safari",
            platform: "ipados",
            requestedAt: "2026-11-12T20:00:00Z",
            expiresAt: "2026-11-12T20:10:00Z",
          },
        }),
      )
      .mockReturnValueOnce(answer(201, { display: { id: DISPLAY_ID } }));
    const { container } = renderWithQuery(
      <HouseholdDisplaysManager homeId={HOME_ID} displays={[]} words={words} />,
    );
    expect(await axeViolations(container)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Check code" }));
    expect(
      await screen.findByText("Enter the 8-character code exactly as the tablet shows it."),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    await user.type(screen.getByRole("textbox", { name: /Pairing code/ }), "abcd efgh");
    await user.click(screen.getByRole("button", { name: "Check code" }));
    expect(await screen.findByText("Tablet: Safari on iPad")).toBeInTheDocument();
    expect(screen.getByText("Code ABCD-EFGH")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/homes/${HOME_ID}/displays/check`);
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ code: "ABCDEFGH" });
    expect(await axeViolations(container)).toEqual([]);

    await user.type(screen.getByRole("textbox", { name: /Display name/ }), "Keuken");
    await user.click(screen.getByRole("button", { name: "Approve display" }));
    expect(
      await screen.findByText(
        "Keuken is paired. The tablet switches to the display in a few seconds.",
      ),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/homes/${HOME_ID}/displays`);
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toEqual({
      requestId: REQUEST_ID,
      code: "ABCDEFGH",
      name: "Keuken",
    });
    expect(router.refresh).toHaveBeenCalled();
  });

  it.each([
    [404, "invalid-code", "This code is not right. Check the code on the tablet and try again."],
    [409, "expired", "This code has expired. Ask the tablet for a new code and enter that one."],
    [409, "already-used", "This code has already been used. Ask the tablet for a new code."],
    [429, "rate-limited", "Too many wrong codes. Wait a few minutes before trying again."],
  ])("explains a refused code (%s %s)", async (status, error, message) => {
    const user = userEvent.setup();
    fetchMock.mockReturnValueOnce(answer(status, { error }));
    renderWithQuery(<HouseholdDisplaysManager homeId={HOME_ID} displays={[]} words={words} />);
    await user.type(screen.getByRole("textbox", { name: /Pairing code/ }), "ABCD-EFGH");
    await user.click(screen.getByRole("button", { name: "Check code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("lists displays, renames one and revokes one", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValueOnce(answer(200, {})).mockReturnValueOnce(answer(200, {}));
    renderWithQuery(
      <HouseholdDisplaysManager
        homeId={HOME_ID}
        displays={[
          active,
          { ...active, id: REQUEST_ID, name: "Oud", active: false, revokedAt: "1 Nov 2026" },
        ]}
        words={words}
      />,
    );
    expect(
      screen.getByText("Paired 12 Nov 2026, 20:00 by Alice · not seen yet"),
    ).toBeInTheDocument();
    expect(screen.getByText("Recently revoked")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Rename Keuken" }));
    const field = screen.getByRole("textbox", { name: "New name for Keuken" });
    await user.clear(field);
    await user.type(field, "Hal");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByText("Name saved.")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/v1/homes/${HOME_ID}/displays/${DISPLAY_ID}/rename`,
    );
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ name: "Hal" });

    await user.click(screen.getByRole("button", { name: "Revoke Keuken" }));
    expect(
      await screen.findByText("The display is revoked. It goes back to its pairing screen."),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `/api/v1/homes/${HOME_ID}/displays/${DISPLAY_ID}/revoke`,
    );
  });
});
