import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { SettingsGroup, SettingsLayout } from "./settings-layout";

const sections = [
  { id: "profile", label: "Account" },
  { id: "security", label: "Security and privacy" },
];

function renderLayout() {
  return renderWithIntl(
    <SettingsLayout sections={sections}>
      <SettingsGroup id="profile" label="Account">
        <p>Name</p>
      </SettingsGroup>
      <SettingsGroup id="security" label="Security and privacy">
        <p>Password</p>
      </SettingsGroup>
    </SettingsLayout>,
  );
}

describe("SettingsLayout", () => {
  afterEach(() => {
    window.location.hash = "";
  });

  it("lists every section as a link to its group, plus a dropdown for narrow screens", () => {
    renderLayout();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(nav.querySelector('a[href="#security"]')).toHaveTextContent("Security and privacy");
    expect(screen.getByRole("combobox", { name: "Jump to section" })).toHaveValue("profile");
    expect(document.getElementById("security")).toHaveTextContent("Password");
  });

  it("marks the section from the address as current", () => {
    window.location.hash = "#security";
    renderLayout();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(nav.querySelector('a[href="#security"]')).toHaveAttribute("aria-current", "location");
    expect(nav.querySelector('a[href="#profile"]')).not.toHaveAttribute("aria-current");
  });

  it("jumps to a section chosen in the dropdown", async () => {
    const user = userEvent.setup();
    renderLayout();
    await user.selectOptions(screen.getByRole("combobox", { name: "Jump to section" }), "security");
    expect(window.location.hash).toBe("#security");
  });

  it("has no axe violations", async () => {
    const { container } = renderLayout();
    expect(await axeViolations(container)).toEqual([]);
  });
});
