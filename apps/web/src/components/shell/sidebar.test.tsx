import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { FavoritesProvider } from "./favorites";
import { Sidebar } from "./sidebar";

const navigation = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

function clearCookies() {
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}

beforeEach(() => {
  navigation.pathname = "/";
  clearCookies();
});

describe("Sidebar", () => {
  it("lists every destination with its label and marks the current page", () => {
    navigation.pathname = "/calendar";
    renderWithIntl(<Sidebar initialState="expanded" />);

    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");
    // Core destinations, the Personal defaults (nothing pinned yet), All modules, then Settings and Help.
    expect(links.map((link) => link.textContent)).toEqual([
      "Dashboard",
      "Calendar",
      "Tasks",
      "Shopping",
      "Habits",
      "Goals",
      "All modules",
      "Settings",
      "Help",
    ]);
    expect(within(nav).getByRole("link", { name: "Calendar" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Dashboard" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("collapses and expands, saving the choice on this device", async () => {
    const user = userEvent.setup();
    const { container } = renderWithIntl(<Sidebar initialState="expanded" />);
    const aside = container.querySelector("aside");

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(aside).toHaveAttribute("data-state", "collapsed");
    expect(document.cookie).toContain("md-sidebar=collapsed");

    await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(aside).toHaveAttribute("data-state", "expanded");
    expect(document.cookie).toContain("md-sidebar=expanded");
  });

  it("keeps every item's name for assistive technology when collapsed", () => {
    renderWithIntl(<Sidebar initialState="collapsed" />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    for (const name of ["Dashboard", "Shopping", "All modules", "Settings", "Help"]) {
      expect(within(nav).getByRole("link", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: "Madeora, go to the dashboard" })).toBeInTheDocument();
  });

  it("shows the Home defaults in a Home and the pinned shortcuts once the person chose", () => {
    navigation.pathname = "/homes/0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/tasks";
    const { unmount } = renderWithIntl(<Sidebar initialState="expanded" />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual([
      "Dashboard",
      "Calendar",
      "Tasks",
      "Chores",
      "Meals",
      "Shopping",
      "All modules",
      "Settings",
      "Help",
    ]);
    expect(within(nav).getByRole("link", { name: "All modules" })).toHaveAttribute(
      "href",
      "/homes/0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/modules",
    );
    unmount();

    renderWithIntl(
      <FavoritesProvider initial={["pets"]}>
        <Sidebar initialState="expanded" />
      </FavoritesProvider>,
    );
    const pinned = screen.getByRole("navigation", { name: "Main" });
    expect(within(pinned).getByRole("link", { name: "Pets" })).toBeInTheDocument();
    expect(within(pinned).queryByRole("link", { name: "Chores" })).not.toBeInTheDocument();
  });

  it("is translated", () => {
    renderWithIntl(<Sidebar initialState="expanded" />, "nl");
    expect(screen.getByRole("navigation", { name: "Hoofdmenu" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Agenda" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zijbalk inklappen" })).toBeInTheDocument();
  });

  it.each(["expanded", "collapsed"] as const)("has no axe violations when %s", async (state) => {
    const { container } = renderWithIntl(<Sidebar initialState={state} />);
    expect(await axeViolations(container)).toEqual([]);
  });
});
