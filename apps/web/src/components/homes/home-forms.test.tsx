import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { CreateHomeForm } from "./create-home-form";
import { HomeSettingsForm } from "./home-settings-form";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): unknown =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown;

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const zones = ["America/New_York", "Europe/Brussels", "UTC"];

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  router.push.mockClear();
  router.refresh.mockClear();
});

describe("CreateHomeForm", () => {
  it("creates the Home with the typed name and chosen timezone, then opens it", async () => {
    fetchMock.mockResolvedValue(Response.json({ home: { id: HOME_ID } }, { status: 201 }));
    const user = userEvent.setup();
    renderWithQuery(<CreateHomeForm defaultTimeZone="Europe/Brussels" timeZoneChoices={zones} />);
    expect(screen.getByRole("combobox", { name: "Home timezone" })).toHaveValue("Europe/Brussels");

    await user.type(screen.getByRole("textbox", { name: /Home name/ }), "  Thuis  ");
    await user.selectOptions(screen.getByRole("combobox", { name: "Home timezone" }), "UTC");
    await user.click(screen.getByRole("button", { name: "Create Home" }));

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(`/homes/${HOME_ID}`);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/homes");
    expect(init?.method).toBe("POST");
    expect(bodyOf(init)).toEqual({
      name: "Thuis",
      timeZone: "UTC",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
    });
  });

  it("refuses an empty, an invisible and a too long name without sending anything", async () => {
    const user = userEvent.setup();
    renderWithQuery(<CreateHomeForm defaultTimeZone="UTC" timeZoneChoices={zones} />);
    const name = screen.getByRole("textbox", { name: /Home name/ });
    const submit = screen.getByRole("button", { name: "Create Home" });

    await user.click(submit);
    expect(await screen.findByText("Enter a name for the Home.")).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveFocus();

    await user.type(name, "\u{200B}\u{200E}");
    await user.click(submit);
    expect(
      await screen.findByText(/no invisible or text-direction characters/),
    ).toBeInTheDocument();

    await user.clear(name);
    await user.type(name, "x".repeat(51));
    await user.click(submit);
    expect(await screen.findByText("Use at most 50 characters.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the same request id again when retrying after a failure, so only one Home is made", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(Response.json({ home: { id: HOME_ID } }, { status: 201 }));
    const user = userEvent.setup();
    renderWithQuery(<CreateHomeForm defaultTimeZone="UTC" timeZoneChoices={zones} />);
    await user.type(screen.getByRole("textbox", { name: /Home name/ }), "Thuis");
    await user.click(screen.getByRole("button", { name: "Create Home" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Madeora can't be reached");

    await user.click(screen.getByRole("button", { name: "Create Home" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledTimes(1);
    });
    const [first, second] = fetchMock.mock.calls.map(([, init]) => bodyOf(init));
    expect((first as { requestId: string }).requestId).toBe(
      (second as { requestId: string }).requestId,
    );
  });

  it("refreshes the page when the person turns out to be signed out", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "unauthenticated" }, { status: 401 }));
    const user = userEvent.setup();
    renderWithQuery(<CreateHomeForm defaultTimeZone="UTC" timeZoneChoices={zones} />);
    await user.type(screen.getByRole("textbox", { name: /Home name/ }), "Thuis");
    await user.click(screen.getByRole("button", { name: "Create Home" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You're signed out");
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("is in Dutch and has no axe violations", async () => {
    const { container } = renderWithQuery(
      <CreateHomeForm defaultTimeZone="UTC" timeZoneChoices={zones} />,
      "nl",
    );
    expect(screen.getByRole("button", { name: "Home aanmaken" })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("HomeSettingsForm", () => {
  const home = { id: HOME_ID, name: "Thuis", timeZone: "Europe/Brussels" };

  it("sends only the changed field to this Home and confirms the save", async () => {
    fetchMock.mockResolvedValue(Response.json({ home: { ...home, name: "Ons huis" } }));
    const user = userEvent.setup();
    renderWithQuery(<HomeSettingsForm home={home} timeZoneChoices={zones} />);
    const name = screen.getByRole("textbox", { name: /Home name/ });
    await user.clear(name);
    await user.type(name, "Ons huis");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Home settings saved.")).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/homes/${HOME_ID}`);
    expect(init?.method).toBe("PATCH");
    expect(bodyOf(init)).toEqual({ name: "Ons huis" });
    expect(router.refresh).toHaveBeenCalled();
  });

  it("sends nothing when nothing changed", async () => {
    const user = userEvent.setup();
    renderWithQuery(<HomeSettingsForm home={home} timeZoneChoices={zones} />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says so when the role does not allow the change", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "not-permitted" }, { status: 403 }));
    const user = userEvent.setup();
    renderWithQuery(<HomeSettingsForm home={home} timeZoneChoices={zones} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Home timezone" }), "UTC");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You can't change this Home's settings.",
    );
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ timeZone: "UTC" });
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("refreshes the page when the Home is no longer available", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "not-found" }, { status: 404 }));
    const user = userEvent.setup();
    renderWithQuery(<HomeSettingsForm home={home} timeZoneChoices={zones} />);
    await user.type(screen.getByRole("textbox", { name: /Home name/ }), "!");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("isn't available to you any more");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("has no axe violations", async () => {
    const { container } = renderWithQuery(<HomeSettingsForm home={home} timeZoneChoices={zones} />);
    expect(await axeViolations(container)).toEqual([]);
  });
});
