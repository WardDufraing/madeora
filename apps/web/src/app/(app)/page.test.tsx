import { screen, within } from "@testing-library/react";

import { detectRegionalFormats } from "@/preferences/regional";
import { noPreferences, type StoredPreferences } from "@/preferences/schema";
import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import Dashboard from "./page";

interface State {
  locale: "en" | "nl";
  stored: StoredPreferences | null;
  timeZone: string;
  zoneSource: "chosen" | "device" | "fallback";
  homes: { id: string; name: string; timeZone: string; role: string }[];
  remembered: { kind: "personal" } | { kind: "home"; homeId: string } | null;
  memberOf: Set<string>;
}
const state = vi.hoisted((): State => ({
  locale: "en",
  stored: null,
  timeZone: "UTC",
  zoneSource: "device",
  homes: [],
  remembered: null,
  memberOf: new Set(),
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";

class Redirect extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
// The former-Owner notice is an async server component with its own reads; covered on its own.
vi.mock("@/components/recovery/recovered-homes-notice", () => ({
  RecoveredHomesNotice: () => null,
}));
vi.mock("@/homes/server", () => ({
  listMyHomes: () => Promise.resolve({ status: "ok", homes: state.homes }),
  getRememberedContext: () => Promise.resolve(state.remembered),
  getHomeContext: (homeId: string) =>
    Promise.resolve(
      state.memberOf.has(homeId)
        ? { status: "ok", context: { home: { id: homeId, name: "Thuis", timeZone: "UTC" } } }
        : { status: "not-found" },
    ),
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
  state.homes = [];
  state.remembered = null;
  state.memberOf = new Set();
  vi.useFakeTimers({ toFake: ["Date"] });
  // 31 December 2026, 23:30 UTC: already 1 January 2027 in Brussels.
  vi.setSystemTime(new Date(Date.UTC(2026, 11, 31, 23, 30)));
});
afterEach(() => {
  vi.useRealTimers();
});

function DashboardPage(params: { context?: string; notice?: string } = {}) {
  return Dashboard({ searchParams: Promise.resolve(params) });
}

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

  it("hides the Create/Join card once the person has a Home (the switcher offers Create a Home)", async () => {
    state.homes = [{ id: HOME_ID, name: "Thuis", timeZone: "UTC", role: "owner" }];
    renderWithIntl(await DashboardPage({ context: "personal" }));
    expect(screen.queryByRole("region", { name: "Homes" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Your widgets" })).toBeInTheDocument();
  });

  it("returns to the Home this device used last while the person still belongs to it", async () => {
    state.remembered = { kind: "home", homeId: HOME_ID };
    state.memberOf = new Set([HOME_ID]);
    await expect(DashboardPage()).rejects.toEqual(new Redirect(`/homes/${HOME_ID}`));
  });

  it("stays personal when the remembered Home is no longer theirs, and says nothing about it", async () => {
    state.remembered = { kind: "home", homeId: HOME_ID };
    renderWithIntl(await DashboardPage());
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("stays personal when Personal was chosen, even with a remembered Home", async () => {
    state.remembered = { kind: "home", homeId: HOME_ID };
    state.memberOf = new Set([HOME_ID]);
    renderWithIntl(await DashboardPage({ context: "personal" }));
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
  });

  it("explains neutrally that a Home could not be opened", async () => {
    state.remembered = { kind: "home", homeId: HOME_ID };
    state.memberOf = new Set([HOME_ID]);
    renderWithIntl(await DashboardPage({ notice: "home-unavailable" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "That Home isn't available to you. You're in your personal space.",
    );
  });

  it("ignores unknown notices", async () => {
    renderWithIntl(await DashboardPage({ notice: "<script>" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = renderWithIntl(await DashboardPage());
    expect(await axeViolations(container)).toEqual([]);
  });
});
