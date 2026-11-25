import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { DisplayAmbientSetting } from "./display-ambient-setting";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const fetchMock = vi.fn<typeof fetch>();
const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const answer = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  fetchMock.mockReset();
  router.refresh.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROPS = {
  homeId: HOME_ID,
  ambientAfterSeconds: 300,
  ambientShowChores: false,
  ambientShowShopping: false,
} as const;

describe("DisplayAmbientSetting (UX8a, UX8b)", () => {
  it("offers the timings with the current one chosen, accessibly", async () => {
    const { container } = renderWithQuery(<DisplayAmbientSetting {...PROPS} />);
    const select = screen.getByLabelText("Show the ambient view after");
    expect(select).toHaveValue("300");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "1 minute",
      "2 minutes",
      "5 minutes",
      "10 minutes",
      "15 minutes",
      "30 minutes",
    ]);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("saves the chosen timing for the Home and says so", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValueOnce(answer(200, {}));
    renderWithQuery(<DisplayAmbientSetting {...PROPS} />);
    await user.selectOptions(screen.getByLabelText("Show the ambient view after"), "600");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Ambient mode saved.")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/homes/${HOME_ID}/displays/settings`);
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(JSON.parse(typeof body === "string" ? body : "null")).toEqual({
      ambientAfterSeconds: 600,
      ambientShowChores: false,
      ambientShowShopping: false,
    });
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
  });

  it("offers the ambient counts, off by default, and saves the chosen ones", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValueOnce(answer(200, {}));
    const { container } = renderWithQuery(<DisplayAmbientSetting {...PROPS} />);
    const chores = screen.getByRole("checkbox", { name: "Number of open chores" });
    const shopping = screen.getByRole("checkbox", { name: "Number of shopping items left" });
    expect(chores).not.toBeChecked();
    expect(shopping).not.toBeChecked();
    expect(
      screen.getByRole("group", { name: "Also show in the ambient view" }),
    ).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
    await user.click(shopping);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Ambient mode saved.")).toBeInTheDocument();
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(JSON.parse(typeof body === "string" ? body : "null")).toEqual({
      ambientAfterSeconds: 300,
      ambientShowChores: false,
      ambientShowShopping: true,
    });
  });

  it("starts from the Home's saved counts", () => {
    renderWithQuery(<DisplayAmbientSetting {...PROPS} ambientShowChores />);
    expect(screen.getByRole("checkbox", { name: "Number of open chores" })).toBeChecked();
  });

  it("shows a refusal", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValueOnce(answer(403, { error: "not-permitted" }));
    renderWithQuery(<DisplayAmbientSetting {...PROPS} />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Ambient mode saved.")).not.toBeInTheDocument();
  });
});
