import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { defaultOraSettings, type OraSettings } from "@/ora/settings";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { OraSettingsForm } from "./ora-settings-form";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const homes = [{ id: HOME_ID, name: "Thuis" }];
const bodies: unknown[] = [];
let status = 200;

beforeEach(() => {
  bodies.length = 0;
  status = 200;
  navigation.refresh.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      bodies.push(typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null);
      return Promise.resolve(new Response("{}", { status }));
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(settings: Partial<OraSettings> = {}) {
  return renderWithQuery(
    <OraSettingsForm settings={{ ...defaultOraSettings, ...settings }} homes={homes} />,
  );
}

describe("Ora settings", () => {
  it("hides and disables Ora with one switch, saved at once, and says it was saved", async () => {
    const user = userEvent.setup();
    setup();
    const toggle = screen.getByRole("switch", { name: "Ora is shown" });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(screen.getByRole("switch", { name: "Ora is hidden and disabled" })).not.toBeChecked();
    await waitFor(() => {
      expect(bodies).toEqual([{ enabled: false }]);
    });
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(navigation.refresh).toHaveBeenCalled();
  });

  it("offers the three motion modes with Gentle motion as the default, and saves the choice", async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.getByRole("radio", { name: "Gentle motion" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "No motion" }));
    expect(screen.getByRole("radio", { name: "No motion" })).toBeChecked();
    await waitFor(() => {
      expect(bodies).toEqual([{ motion: "none" }]);
    });
    expect(screen.getByRole("radio", { name: "Reactions only" })).not.toBeChecked();
  });

  it("saves the frequency, each category switch and quiet hours, and puts a refused change back (S47b)", async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.getByRole("radio", { name: "Balanced" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Quiet" }));
    await user.click(screen.getByRole("switch", { name: "Celebrations" }));
    await user.click(screen.getByRole("switch", { name: "Use quiet hours" }));
    await waitFor(() => {
      expect(bodies).toEqual([
        { frequency: "quiet" },
        { categories: { celebrations: false } },
        { quietHours: { start: "22:00", end: "07:00" } },
      ]);
    });
    expect(screen.getByLabelText("From")).toHaveValue("22:00");
    await user.click(screen.getByRole("switch", { name: "Use quiet hours" }));
    await waitFor(() => {
      expect(bodies.at(-1)).toEqual({ quietHours: null });
    });
    expect(screen.queryByLabelText("From")).toBeNull();

    status = 500;
    await user.click(screen.getByRole("switch", { name: "Suggestions" }));
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "Suggestions" })).toBeChecked();
    });
  });

  it("shows nine named colours for Personal and for each Home, Heather selected by default", () => {
    setup();
    const personal = screen.getByRole("group", { name: "Personal" });
    expect(within(personal).getAllByRole("radio")).toHaveLength(9);
    expect(within(personal).getByRole("radio", { name: /Heather/ })).toBeChecked();
    const home = screen.getByRole("group", { name: "Thuis" });
    expect(within(home).getAllByRole("radio")).toHaveLength(9);
    expect(within(home).getByRole("radio", { name: /Heather/ })).toBeChecked();
  });

  it("marks the selected colour with more than colour, and saves per Home without touching Personal", async () => {
    const user = userEvent.setup();
    setup();
    const home = screen.getByRole("group", { name: "Thuis" });
    await user.click(within(home).getByRole("radio", { name: /Olive/ }));
    expect(within(home).getByRole("radio", { name: /Olive/ })).toBeChecked();
    // A visible check mark and a text for assistive technology, not colour alone.
    expect(within(home).getByText("Selected")).toBeInTheDocument();
    expect(home.querySelectorAll("svg[aria-hidden='true']").length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(bodies).toEqual([{ homePalette: { homeId: HOME_ID, palette: "olive" } }]);
    });
    const personal = screen.getByRole("group", { name: "Personal" });
    expect(within(personal).getByRole("radio", { name: /Heather/ })).toBeChecked();
  });

  it("saves the Personal colour on its own", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(
      within(screen.getByRole("group", { name: "Personal" })).getByRole("radio", { name: /Denim/ }),
    );
    await waitFor(() => {
      expect(bodies).toEqual([{ personalPalette: "denim" }]);
    });
  });

  it("puts the control back and says why when a save fails", async () => {
    const user = userEvent.setup();
    status = 500;
    setup();
    await user.click(screen.getByRole("switch", { name: "Ora is shown" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("couldn't be saved");
    expect(screen.getByRole("switch", { name: "Ora is shown" })).toBeChecked();
    expect(screen.queryByText("Saved.")).toBeNull();
  });

  it("tells a person who left a Home that it no longer applies", async () => {
    const user = userEvent.setup();
    status = 403;
    setup();
    await user.click(
      within(screen.getByRole("group", { name: "Thuis" })).getByRole("radio", { name: /Brick/ }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer belong to that Home");
    expect(
      within(screen.getByRole("group", { name: "Thuis" })).getByRole("radio", { name: /Heather/ }),
    ).toBeChecked();
  });

  it("has no accessibility violations", async () => {
    const { container } = setup();
    expect(await axeViolations(container)).toEqual([]);
  });
});
