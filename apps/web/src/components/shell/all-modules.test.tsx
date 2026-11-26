import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { AllModules } from "./all-modules";
import { FavoritesProvider } from "./favorites";
import { Sidebar } from "./sidebar";

const navigation = vi.hoisted(() => ({ pathname: "/modules" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";

beforeEach(() => {
  navigation.pathname = "/modules";
  document.cookie = "md-favorites=; Max-Age=0; Path=/";
});

describe("AllModules", () => {
  it("lists the core destinations and every module with a pin control", () => {
    renderWithIntl(
      <FavoritesProvider initial={null}>
        <AllModules homeId={null} />
      </FavoritesProvider>,
    );
    expect(screen.getByRole("link", { name: "Calendar" })).toHaveAttribute("href", "/calendar");
    expect(screen.getByRole("link", { name: "Pets" })).toHaveAttribute("href", "/pets");
    // Core destinations cannot be pinned or unpinned.
    expect(screen.queryByRole("button", { name: /Calendar/ })).not.toBeInTheDocument();
    // Personal defaults are shown as pinned.
    expect(screen.getByRole("switch", { name: "Pin Shopping to shortcuts" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("switch", { name: "Pin Pets to shortcuts" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("opens the Home's pages inside a Home", () => {
    navigation.pathname = `/homes/${HOME}/modules`;
    renderWithIntl(
      <FavoritesProvider initial={null}>
        <AllModules homeId={HOME} />
      </FavoritesProvider>,
    );
    expect(screen.getByRole("link", { name: "Chores" })).toHaveAttribute(
      "href",
      `/homes/${HOME}/chores`,
    );
  });

  it("filters by name and says when nothing matches", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <FavoritesProvider initial={null}>
        <AllModules homeId={null} />
      </FavoritesProvider>,
    );
    await user.type(screen.getByRole("searchbox", { name: "Search modules" }), "pet");
    expect(screen.getByRole("link", { name: "Pets" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Goals" })).not.toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "Search modules" }));
    await user.type(screen.getByRole("searchbox", { name: "Search modules" }), "zzz");
    expect(screen.getByText("No module matches “zzz”.")).toBeInTheDocument();
  });

  it("pins a module, saves the choice on this device and updates the sidebar at once", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <FavoritesProvider initial={null}>
        <Sidebar initialState="expanded" />
        <AllModules homeId={null} />
      </FavoritesProvider>,
    );
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).queryByRole("link", { name: "Pets" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Pin Pets to shortcuts" }));
    expect(within(nav).getByRole("link", { name: "Pets" })).toBeInTheDocument();
    expect(document.cookie).toContain("md-favorites=shopping%2Chabits%2Cgoals%2Cpets");
    expect(screen.getByRole("switch", { name: "Pin Pets to shortcuts" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await user.click(screen.getByRole("switch", { name: "Pin Pets to shortcuts" }));
    expect(within(nav).queryByRole("link", { name: "Pets" })).not.toBeInTheDocument();
  });

  it("is translated and has no axe violations", async () => {
    const { container } = renderWithIntl(
      <FavoritesProvider initial={null}>
        <AllModules homeId={null} />
      </FavoritesProvider>,
      "nl",
    );
    expect(screen.getByRole("searchbox", { name: "Modules zoeken" })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("toggles a shortcut from the keyboard with Space", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <FavoritesProvider initial={null}>
        <AllModules homeId={null} />
      </FavoritesProvider>,
    );
    const toggle = screen.getByRole("switch", { name: "Pin Pets to shortcuts" });
    toggle.focus();
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});
