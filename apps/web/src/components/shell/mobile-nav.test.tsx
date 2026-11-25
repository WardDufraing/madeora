import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { MobileNav } from "./mobile-nav";

const navigation = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

describe("MobileNav", () => {
  it("opens a labelled menu dialog with every destination, and closes it again", async () => {
    const user = userEvent.setup();
    renderWithIntl(<MobileNav />);
    const button = screen.getByRole("button", { name: "More" });
    expect(button).toHaveAttribute("aria-haspopup", "dialog");

    await user.click(button);
    const dialog = screen.getByRole("dialog", { name: "Menu" });
    const nav = within(dialog).getByRole("navigation", { name: "Main" });
    expect(within(nav).getAllByRole("link")).toHaveLength(13);

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it("has a bottom bar with Dashboard, Calendar, Create, Tasks and More", () => {
    renderWithIntl(<MobileNav />);
    const bar = screen.getByRole("navigation", { name: "Quick navigation" });
    expect(
      within(bar)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Dashboard", "Calendar", "Create", "Tasks", "More"]);
  });

  it("marks the current tab", () => {
    navigation.pathname = "/calendar";
    renderWithIntl(<MobileNav />);
    const bar = screen.getByRole("navigation", { name: "Quick navigation" });
    expect(within(bar).getByRole("link", { name: "Calendar" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(bar).getByRole("link", { name: "Tasks" })).not.toHaveAttribute("aria-current");
    navigation.pathname = "/";
  });

  it("opens the Create menu with the quick-create entries for the open context", async () => {
    const user = userEvent.setup();
    navigation.pathname = "/homes/0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    renderWithIntl(<MobileNav />);
    const create = screen.getByRole("button", { name: "Create" });
    await user.click(create);
    const dialog = screen.getByRole("dialog", { name: "Create something new" });
    expect(within(dialog).getByRole("link", { name: "New event" })).toHaveAttribute(
      "href",
      "/homes/0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/calendar/new",
    );
    expect(within(dialog).getByRole("link", { name: "New task" })).toHaveAttribute(
      "href",
      "/homes/0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/tasks",
    );
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(create).toHaveFocus();
    navigation.pathname = "/";
  });

  it("stays shown while focus is inside it", async () => {
    const user = userEvent.setup();
    renderWithIntl(<MobileNav />);
    const bar = screen.getByRole("navigation", { name: "Quick navigation" });
    await user.tab();
    expect(bar).toHaveAttribute("data-hidden", "false");
  });

  it("has no axe violations in the bar and with the Create menu open", async () => {
    const user = userEvent.setup();
    const { container } = renderWithIntl(<MobileNav />);
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await axeViolations(container)).toEqual([]);
  });

  it("closes when a destination is chosen", async () => {
    const user = userEvent.setup();
    renderWithIntl(<MobileNav />);
    await user.click(screen.getByRole("button", { name: "More" }));
    const dialog = screen.getByRole("dialog", { name: "Menu" });
    const link = within(dialog).getByRole("link", { name: "Tasks" });
    // jsdom does not navigate; prevent it from trying.
    link.addEventListener("click", (event) => {
      event.preventDefault();
    });
    await user.click(link);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("has no axe violations while open", async () => {
    const user = userEvent.setup();
    const { container } = renderWithIntl(<MobileNav />);
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(await axeViolations(container)).toEqual([]);
  });
});
