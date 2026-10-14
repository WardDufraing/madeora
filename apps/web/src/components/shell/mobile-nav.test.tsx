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
    const button = screen.getByRole("button", { name: "Open menu" });
    expect(button).toHaveAttribute("aria-haspopup", "dialog");

    await user.click(button);
    const dialog = screen.getByRole("dialog", { name: "Menu" });
    const nav = within(dialog).getByRole("navigation", { name: "Main" });
    expect(within(nav).getAllByRole("link")).toHaveLength(12);

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it("closes when a destination is chosen", async () => {
    const user = userEvent.setup();
    renderWithIntl(<MobileNav />);
    await user.click(screen.getByRole("button", { name: "Open menu" }));
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
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    expect(await axeViolations(container)).toEqual([]);
  });
});
