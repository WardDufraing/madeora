import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { detectRegionalFormats, regionalSamples } from "@/preferences/regional";
import { noPreferences, type StoredPreferences } from "@/preferences/schema";
import { axeViolations } from "@/test/axe";
import { renderWithIntl, renderWithQuery } from "@/test/intl";

import { DisplayNameSetting } from "./display-name-setting";
import { LanguageSetting } from "./language-setting";
import { RegionalSetting } from "./regional-setting";
import { ThemeSetting } from "./theme-setting";
import { TimeZoneSetting } from "./time-zone-setting";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): string =>
  typeof init?.body === "string" ? init.body : "";

/** The API answers with the saved preferences: the defaults plus the change it received. */
function apiSaves(base: StoredPreferences = noPreferences) {
  fetchMock.mockImplementation((_url, init) => {
    const patch = JSON.parse(bodyOf(init)) as Partial<StoredPreferences>;
    return Promise.resolve(Response.json({ preferences: { ...base, ...patch } }));
  });
}

function sentPatches(): unknown[] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(bodyOf(init)) as unknown);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  document.cookie = "md-locale=; Max-Age=0; Path=/";
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
    // Server-rendered data is refreshed, so Back and Forward show the new choice.
    expect(router.refresh).toHaveBeenCalledTimes(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is translated", () => {
    renderWithIntl(<ThemeSetting initialTheme="dark" />, "nl");
    expect(screen.getByRole("group", { name: "Thema" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Donker" })).toBeChecked();
  });
});

describe("LanguageSetting", () => {
  it("lists each language in its own language, saves the choice on the account and this device, then re-renders", async () => {
    apiSaves();
    const user = userEvent.setup();
    renderWithQuery(<LanguageSetting currentLocale="en" />);
    expect(screen.getByRole("group", { name: "Language" })).toHaveAccessibleDescription(
      "Saved to your account and used on all your devices.",
    );
    expect(screen.getByRole("radio", { name: "English" })).toBeChecked();
    const dutch = screen.getByRole("radio", { name: "Nederlands" });
    expect(dutch.closest("label")?.querySelector("[lang]")).toHaveAttribute("lang", "nl");

    await user.click(dutch);
    expect(dutch).toBeChecked();
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalledTimes(1);
    });
    expect(sentPatches()).toEqual([{ locale: "nl" }]);
    expect(document.cookie).toContain("md-locale=nl");
  });

  it("shows the language in use again, and says why, when saving fails", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "failed" }, { status: 500 }));
    const user = userEvent.setup();
    renderWithQuery(<LanguageSetting currentLocale="en" />);
    await user.click(screen.getByRole("radio", { name: "Nederlands" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Something went wrong while saving.",
    );
    expect(screen.getByRole("radio", { name: "English" })).toBeChecked();
    expect(document.cookie).not.toContain("md-locale=nl");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("has no axe violations together with the theme setting", async () => {
    const { container } = renderWithQuery(
      <>
        <ThemeSetting initialTheme="light" />
        <LanguageSetting currentLocale="nl" />
      </>,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("DisplayNameSetting", () => {
  it("saves a trimmed name and confirms it", async () => {
    apiSaves();
    const user = userEvent.setup();
    renderWithQuery(<DisplayNameSetting initialName={null} />);
    const field = screen.getByRole("textbox", { name: "Display name" });
    expect(field).toHaveValue("");
    await user.type(field, "  Sam  ");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Display name saved.");
    expect(sentPatches()).toEqual([{ displayName: "Sam" }]);
    expect(field).toHaveValue("Sam");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("removes the name when the field is emptied", async () => {
    apiSaves();
    const user = userEvent.setup();
    renderWithQuery(<DisplayNameSetting initialName="Sam" />);
    await user.clear(screen.getByRole("textbox", { name: "Display name" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("status");
    expect(sentPatches()).toEqual([{ displayName: null }]);
  });

  it("explains a name that is too long next to the field, and sends nothing", async () => {
    const user = userEvent.setup();
    renderWithQuery(<DisplayNameSetting initialName={null} />);
    const field = screen.getByRole("textbox", { name: "Display name" });
    await user.type(field, "a".repeat(51));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(field).toHaveAccessibleDescription(
      expect.stringContaining("Use at most 50 characters."),
    );
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the typed name and says so when the session has ended", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "unauthenticated" }, { status: 401 }));
    const user = userEvent.setup();
    renderWithQuery(<DisplayNameSetting initialName={null} />);
    const field = screen.getByRole("textbox", { name: "Display name" });
    await user.type(field, "Sam");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You're signed out.");
    expect(field).toHaveValue("Sam");
  });

  it("sends nothing when the name was not changed, so another device's change stays", async () => {
    const user = userEvent.setup();
    renderWithQuery(<DisplayNameSetting initialName="Sam" />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a name of invisible characters only", async () => {
    const user = userEvent.setup();
    renderWithQuery(<DisplayNameSetting initialName={null} />);
    const field = screen.getByRole("textbox", { name: "Display name" });
    await user.type(field, "\u200B\u200B");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("has no axe violations", async () => {
    const { container } = renderWithQuery(<DisplayNameSetting initialName="Sam" />, "nl");
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("RegionalSetting", () => {
  const belgian = detectRegionalFormats("nl-BE");
  const preview = (name: string) => document.querySelector(`[data-preview="${name}"]`)?.textContent;

  it("starts on Automatic with a preview of the detected formats", () => {
    renderWithQuery(
      <RegionalSetting
        overrides={noPreferences}
        detected={belgian}
        samples={regionalSamples("en")}
      />,
    );
    expect(screen.getByRole("radio", { name: "Automatic" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Automatic" })).toHaveAccessibleDescription(
      "Based on your browser's language and region.",
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(preview("date")).toBe("31/12/2026");
    expect(preview("time")).toBe("14:30");
    expect(preview("week")).toBe("Mon Tue Wed Thu Fri Sat Sun");
    expect(preview("number")).toBe("1.234.567,89");
    expect(preview("units")).toBe("5,5 km · 21°C · 1,5 kg");
  });

  it("previews each custom choice live, before saving, and saves only the settings changed", async () => {
    apiSaves();
    const user = userEvent.setup();
    renderWithQuery(
      <RegionalSetting
        overrides={noPreferences}
        detected={belgian}
        samples={regionalSamples("en")}
      />,
    );
    await user.click(screen.getByRole("radio", { name: "Custom" }));
    const date = screen.getByRole("combobox", { name: "Date" });
    expect(date).toHaveValue("auto");
    expect(
      within(date).getByRole("option", { name: "Automatic (31/12/2026)" }),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Time" }), "12h");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "First day of the week" }),
      "sunday",
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Units" }), "us-customary");
    expect(preview("time")).toMatch(/^2:30\sPM$/u);
    expect(preview("week")).toBe("Sun Mon Tue Wed Thu Fri Sat");
    expect(preview("units")).toBe("3,4 mi · 70°F · 3,3 lb");
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Regional formats saved.");
    expect(sentPatches()).toEqual([
      { timeFormat: "12h", weekStart: "sunday", measurementSystem: "us-customary" },
    ]);
  });

  it("a page left open never undoes a choice saved on another device", async () => {
    // This page was opened when only the time format was custom; another device has since
    // chosen a date format. Changing the week start here must not send the date format.
    const opened = { ...noPreferences, timeFormat: "12h" } as const;
    apiSaves({ ...opened, dateFormat: "ymd-dash" });
    const user = userEvent.setup();
    renderWithQuery(
      <RegionalSetting overrides={opened} detected={belgian} samples={regionalSamples("en")} />,
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "First day of the week" }),
      "sunday",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("status");
    expect(sentPatches()).toEqual([{ weekStart: "sunday" }]);
    // The form now shows what the account holds, the other device's choice included.
    expect(screen.getByRole("combobox", { name: "Date" })).toHaveValue("ymd-dash");
  });

  it("sends nothing and claims nothing when there is nothing to store", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <RegionalSetting
        overrides={noPreferences}
        detected={belgian}
        samples={regionalSamples("en")}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    // Custom with every format still on Automatic stores nothing either.
    await user.click(screen.getByRole("radio", { name: "Custom" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("announces the preview politely", () => {
    renderWithQuery(
      <RegionalSetting
        overrides={noPreferences}
        detected={belgian}
        samples={regionalSamples("en")}
      />,
    );
    expect(document.querySelector('[data-preview="date"]')?.closest("[aria-live]")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  it("is translated and has no axe violations, with Custom open", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQuery(
      <RegionalSetting
        overrides={noPreferences}
        detected={belgian}
        samples={regionalSamples("nl")}
      />,
      "nl",
    );
    await user.click(screen.getByRole("radio", { name: "Aangepast" }));
    expect(screen.getByRole("combobox", { name: "Eerste dag van de week" })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("TimeZoneSetting", () => {
  const choices = ["Asia/Tokyo", "Europe/Brussels", "UTC"];

  it("names the zone this device reports in Automatic mode", () => {
    renderWithQuery(
      <TimeZoneSetting
        chosen={null}
        deviceSaved="Europe/Brussels"
        choices={choices}
        locale="en"
        timeFormat="24h"
      />,
    );
    const automatic = screen.getByRole("radio", { name: /^Automatic/ });
    expect(automatic).toBeChecked();
    // The test runner is pinned to UTC (vitest.config.ts), so this "device" reports UTC.
    expect(automatic).toHaveAccessibleDescription("This device reports UTC.");
    expect(document.querySelector('[data-preview="time-zone"]')?.textContent).toMatch(
      /^Now in UTC: \d\d:\d\d$/,
    );
  });

  it("saves a chosen zone for every device, and Automatic again", async () => {
    apiSaves();
    const user = userEvent.setup();
    renderWithQuery(
      <TimeZoneSetting
        chosen={null}
        deviceSaved={undefined}
        choices={choices}
        locale="en"
        timeFormat="24h"
      />,
    );
    await user.click(screen.getByRole("radio", { name: "The same timezone on every device" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Timezone to use" }),
      "Asia/Tokyo",
    );
    expect(document.querySelector('[data-preview="time-zone"]')?.textContent).toMatch(
      /^Now in Asia\/Tokyo: /,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Timezone saved.");

    await user.click(screen.getByRole("radio", { name: /^Automatic/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(sentPatches()).toEqual([{ timeZone: "Asia/Tokyo" }, { timeZone: null }]);
    });
  });

  it("preselects the zone this device reports, which the server could not know yet", async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      ...new Intl.DateTimeFormat("en", { timeZone: "UTC" }).resolvedOptions(),
      timeZone: "Europe/Brussels",
    });
    try {
      const user = userEvent.setup();
      renderWithQuery(
        <TimeZoneSetting
          chosen={null}
          deviceSaved={undefined}
          choices={choices}
          locale="en"
          timeFormat="24h"
        />,
      );
      await user.click(screen.getByRole("radio", { name: "The same timezone on every device" }));
      expect(screen.getByRole("combobox", { name: "Timezone to use" })).toHaveValue(
        "Europe/Brussels",
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("sends nothing when the timezone was not changed", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <TimeZoneSetting
        chosen={null}
        deviceSaved={undefined}
        choices={choices}
        locale="en"
        timeFormat="24h"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still works when this browser does not know the chosen zone", () => {
    const real = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(((
      locales?: string | string[],
      options?: Intl.DateTimeFormatOptions,
    ) => {
      if (options?.timeZone === "Asia/Tokyo") throw new RangeError("Invalid time zone");
      return new real(locales, options);
    }) as unknown as typeof Intl.DateTimeFormat);
    try {
      renderWithQuery(
        <TimeZoneSetting
          chosen="Asia/Tokyo"
          deviceSaved={undefined}
          choices={choices}
          locale="en"
          timeFormat="24h"
        />,
      );
      expect(document.querySelector('[data-preview="time-zone"]')?.textContent).toBe("Asia/Tokyo");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("shows a chosen zone as chosen, with zone names readable", () => {
    renderWithQuery(
      <TimeZoneSetting
        chosen="Asia/Tokyo"
        deviceSaved="Europe/Brussels"
        choices={[...choices, "America/New_York"]}
        locale="en"
        timeFormat="12h"
      />,
    );
    expect(screen.getByRole("radio", { name: "The same timezone on every device" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Timezone to use" })).toHaveValue("Asia/Tokyo");
    expect(screen.getByRole("option", { name: "America/New York" })).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = renderWithQuery(
      <TimeZoneSetting
        chosen="Asia/Tokyo"
        deviceSaved={undefined}
        choices={choices}
        locale="nl"
        timeFormat="24h"
      />,
      "nl",
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
