import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithIntl } from "@/test/intl";

import { AccountMenu } from "./account-menu";

function renderMenu(displayName: string | null) {
  return renderWithIntl(
    <QueryClientProvider client={new QueryClient()}>
      <AccountMenu displayName={displayName} />
    </QueryClientProvider>,
  );
}

describe("AccountMenu", () => {
  it("starts closed and shows the person's initial on the avatar", () => {
    renderMenu("ann");
    const button = screen.getByRole("button", { name: "Account menu" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveTextContent("A");
    expect(screen.queryByRole("link", { name: "Switch account" })).toBeNull();
  });

  it("opens to Switch account and Sign out, and Escape closes it again", async () => {
    const user = userEvent.setup();
    renderMenu("Ann");
    const button = screen.getByRole("button", { name: "Account menu" });
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "Switch account" })).toHaveAttribute(
      "href",
      "/accounts",
    );
    expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
  });

  it("works without a display name", async () => {
    const user = userEvent.setup();
    renderMenu(null);
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.queryByText(/Signed in as/)).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  it("closes on a press outside and when focus tabs out", async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <QueryClientProvider client={new QueryClient()}>
        <AccountMenu displayName="Ann" />
        <button type="button">After</button>
      </QueryClientProvider>,
    );
    const button = screen.getByRole("button", { name: "Account menu" });
    await user.click(button);
    await user.click(document.body);
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    await user.tab();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("signs out with a real form POST", async () => {
    const user = userEvent.setup();
    renderMenu("Ann");
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    const form = screen.getByRole("button", { name: "Sign out" }).closest("form");
    expect(form).toHaveAttribute("method", "post");
    expect(form).toHaveAttribute("action", "/auth/sign-out");
  });
});
