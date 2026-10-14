import { screen, within } from "@testing-library/react";

import { detectRegionalFormats } from "@/preferences/regional";
import { noPreferences, type StoredPreferences } from "@/preferences/schema";
import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import DashboardPage from "./page";

interface State {
  locale: "en" | "nl";
  stored: StoredPreferences | null;
  timeZone: string;
  zoneSource: "chosen" | "device" | "fallback";
}
const state = vi.hoisted((): State => ({
  locale: "en",
  stored: null,
  timeZone: "UTC",
  zoneSource: "device",
}));

vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const { default: en } = await import("@/i18n/messages/en.json");
  const { default: nl } = await import("@/i18n/messages/nl.json");
  return {
    getLocale: () => Promise.resolve(state.locale),
    getTranslations: (namespace: string) =>
      Promise.resolve(
        createTranslator({
          locale: state.locale,
          messages: state.locale === "nl" ? nl : en,
          namespace: namespace as "Dashboard",
        }),
      ),
  };
});
vi.mock("@/auth/identity", () => ({
  requireIdentity: () => Promise.resolve({ userId: "synthetic-user" }),
}));
vi.mock("@/preferences/account", () => ({
  getStoredPreferences: () => Promise.resolve(state.stored),
}));
vi.mock("@/preferences/server", async () => {
  const { resolveRegionalFormats } = await import("@/preferences/regional");
  return {
    getEffectiveTimeZone: () =>
      Promise.resolve({ timeZone: state.timeZone, source: state.zoneSource }),
    getRegionalFormats: () => {
      const detected = detectRegionalFormats("en-GB");
      return Promise.resolve({
        detected,
        effective: resolveRegionalFormats(state.stored ?? noPreferences, detected),
      });
    },
  };
});

beforeEach(() => {
  state.locale = "en";
  state.stored = noPreferences;
  state.timeZone = "UTC";
  state.zoneSource = "device";
  vi.useFakeTimers({ toFake: ["Date"] });
  // 31 December 2026, 23:30 UTC: already 1 January 2027 in Brussels.
  vi.setSystemTime(new Date(Date.UTC(2026, 11, 31, 23, 30)));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("DashboardPage", () => {
  it("welcomes a new adult with zero Homes: honest empty widgets and optional Home actions", async () => {
    renderWithIntl(await DashboardPage());
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Welcome to Madeora")).toBeInTheDocument();
    const widgets = screen.getByRole("region", { name: "Your widgets" });
    expect(within(widgets).getByText("No widgets yet")).toBeInTheDocument();
    const homes = screen.getByRole("region", { name: "Homes" });
    expect(within(homes).getByRole("link", { name: "Create a Home" })).toHaveAttribute(
      "href",
      "/homes/new",
    );
    expect(within(homes).getByRole("link", { name: "Join a Home" })).toHaveAttribute(
      "href",
      "/homes/join",
    );
    // Nothing blocks the page: no dialog, and the Home actions are outside the widget area.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(widgets).queryByRole("link")).not.toBeInTheDocument();
  });

  it("greets by display name, isolated so a right-to-left name cannot reorder the sentence", async () => {
    state.stored = { ...noPreferences, displayName: "שרה" };
    renderWithIntl(await DashboardPage());
    expect(screen.getByText("Welcome, \u2068שרה\u2069")).toBeInTheDocument();
  });

  it("shows today's date in the person's timezone and date format", async () => {
    state.stored = { ...noPreferences, dateFormat: "ymd-dash" };
    state.timeZone = "Europe/Brussels";
    renderWithIntl(await DashboardPage());
    const today = screen.getByTestId("today");
    expect(today).toHaveTextContent("Friday 2027-01-01");
    expect(today).toHaveAttribute("dateTime", "2027-01-01");
  });

  it("uses the detected format when Automatic, and the interface language for the weekday", async () => {
    state.locale = "nl";
    renderWithIntl(await DashboardPage(), "nl");
    expect(screen.getByTestId("today")).toHaveTextContent("donderdag 31/12/2026");
    expect(screen.getByRole("link", { name: "Een Home aanmaken" })).toBeInTheDocument();
  });

  it("says which timezone the date is in while the device has not reported one", async () => {
    state.zoneSource = "fallback";
    renderWithIntl(await DashboardPage());
    expect(
      screen.getByText(/\(in UTC, until this device reports its timezone\)/),
    ).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = renderWithIntl(await DashboardPage());
    expect(await axeViolations(container)).toEqual([]);
  });
});
