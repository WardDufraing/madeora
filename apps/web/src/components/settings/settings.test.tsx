import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { LanguageSetting } from "./language-setting";
import { ThemeSetting } from "./theme-setting";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

afterEach(() => {
  delete document.documentElement.dataset.theme;
  router.refresh.mockClear();
});

describe("ThemeSetting", () => {
  it("applies the chosen theme to <html> at once and saves it on this device", async () => {
    const user = userEvent.setup();
    renderWithIntl(<ThemeSetting initialTheme="system" />);
    const group = screen.getByRole("group", { name: "Theme" });
    expect(group).toHaveAccessibleDescription("Saved on this device.");
    expect(screen.getByRole("radio", { name: "Same as this device" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.cookie).toContain("md-theme=dark");

    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");

    await user.click(screen.getByRole("radio", { name: "Same as this device" }));
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(document.cookie).toContain("md-theme=system");
  });

  it("is translated", () => {
    renderWithIntl(<ThemeSetting initialTheme="dark" />, "nl");
    expect(screen.getByRole("group", { name: "Thema" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Donker" })).toBeChecked();
  });
});

describe("LanguageSetting", () => {
  it("lists each language in its own language and saves the choice, then re-renders", async () => {
    const user = userEvent.setup();
    renderWithIntl(<LanguageSetting currentLocale="en" />);
    expect(screen.getByRole("radio", { name: "English" })).toBeChecked();
    const dutch = screen.getByRole("radio", { name: "Nederlands" });
    expect(dutch.closest("label")?.querySelector("[lang]")).toHaveAttribute("lang", "nl");

    await user.click(dutch);
    expect(dutch).toBeChecked();
    expect(document.cookie).toContain("md-locale=nl");
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("has no axe violations together with the theme setting", async () => {
    const { container } = renderWithIntl(
      <>
        <ThemeSetting initialTheme="light" />
        <LanguageSetting currentLocale="nl" />
      </>,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
