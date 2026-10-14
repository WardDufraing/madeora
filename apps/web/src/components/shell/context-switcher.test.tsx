import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { MyHome } from "@/homes/types";
import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { ContextSwitcher } from "./context-switcher";

const navigation = vi.hoisted(() => ({ pathname: "/", refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ refresh: navigation.refresh }),
}));

const HOME_A = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const HOME_B = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0002";
const homes: MyHome[] = [
  { id: HOME_A, name: "Thuis", timeZone: "Europe/Brussels", role: "owner" },
  // A right-to-left name: rendered isolated, so it cannot reorder the role next to it.
  { id: HOME_B, name: "\u{5D1}\u{5D9}\u{5EA}", timeZone: "Asia/Jerusalem", role: "member" },
];

beforeEach(() => {
  navigation.pathname = "/";
  navigation.refresh.mockReset();
});

describe("ContextSwitcher", () => {
  it("names the Personal context with zero Homes and still offers Create and Join a Home", async () => {
    const user = userEvent.setup();
    renderWithIntl(<ContextSwitcher homes={[]} />);
    const button = screen.getByRole("button", { name: "Current context: Personal" });
    expect(button).toHaveAttribute("aria-expanded", "false");

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("navigation", { name: "Switch context" });
    expect(
      within(list)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Personal Current", "Create a Home", "Join a Home"]);
    expect(within(list).getByRole("link", { name: /Personal/ })).toHaveAttribute(
      "href",
      "/?context=personal",
    );
  });

  it("lists every Home with the person's role there, and links to each", async () => {
    const user = userEvent.setup();
    renderWithIntl(<ContextSwitcher homes={homes} />);
    await user.click(screen.getByRole("button", { name: "Current context: Personal" }));
    const list = screen.getByRole("navigation", { name: "Switch context" });
    expect(within(list).getByRole("link", { name: "Thuis Owner" })).toHaveAttribute(
      "href",
      `/homes/${HOME_A}`,
    );
    const rtl = within(list).getByRole("link", { name: /Member/ });
    expect(rtl).toHaveAttribute("href", `/homes/${HOME_B}`);
    expect(rtl.querySelector("bdi")).toHaveTextContent("\u{5D1}\u{5D9}\u{5EA}");
  });

  it("names the open Home and marks it current", async () => {
    navigation.pathname = `/homes/${HOME_A}`;
    const user = userEvent.setup();
    renderWithIntl(<ContextSwitcher homes={homes} />);
    await user.click(screen.getByRole("button", { name: "Current context: Thuis" }));
    expect(screen.getByRole("link", { name: "Thuis Owner, current" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // Only opening the list asked the server for a fresh one.
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
  });

  it("asks the server for the list again once when the open Home is not in it", () => {
    navigation.pathname = "/homes/6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0003";
    renderWithIntl(<ContextSwitcher homes={homes} />);
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Current context: Home" })).toBeInTheDocument();
  });

  it("closes with Escape and returns focus to the button", async () => {
    const user = userEvent.setup();
    renderWithIntl(<ContextSwitcher homes={homes} />);
    const button = screen.getByRole("button", { name: "Current context: Personal" });
    await user.click(button);
    await user.tab();
    expect(screen.getByRole("link", { name: /Personal/ })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
    expect(screen.queryByRole("navigation", { name: "Switch context" })).not.toBeInTheDocument();
  });

  it("closes when focus leaves it", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <>
        <ContextSwitcher homes={[]} />
        <button type="button">Elsewhere</button>
      </>,
    );
    const button = screen.getByRole("button", { name: "Current context: Personal" });
    await user.click(button);
    // Personal, Create a Home, Join a Home, then out.
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("says when the Homes could not be loaded", async () => {
    const user = userEvent.setup();
    renderWithIntl(<ContextSwitcher homes={null} />);
    await user.click(screen.getByRole("button", { name: "Current context: Personal" }));
    expect(screen.getByText(/couldn't be loaded/)).toBeInTheDocument();
  });

  it("is in Dutch for a Dutch interface, with Dutch role names", async () => {
    const user = userEvent.setup();
    renderWithIntl(<ContextSwitcher homes={homes} />, "nl");
    await user.click(screen.getByRole("button", { name: "Huidige omgeving: Persoonlijk" }));
    expect(screen.getByRole("link", { name: "Thuis Eigenaar" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Een Home aanmaken" })).toBeInTheDocument();
  });

  it("has no axe violations, open or closed", async () => {
    const user = userEvent.setup();
    const { container } = renderWithIntl(<ContextSwitcher homes={homes} />);
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Current context: Personal" }));
    expect(await axeViolations(container)).toEqual([]);
  });
});
