import { screen, within } from "@testing-library/react";
import { isValidElement, type ReactElement, type ReactNode } from "react";

import type { HomePermissionProjection } from "@madeora/domain/permissions";
import { addWidget, type DashboardLayout } from "@/dashboard/layout";
import { homeStarterLayout, personalStarterLayout } from "@/dashboard/starter";
import type { WidgetEntry } from "@/dashboard/view-types";
import type { DateTimeFormats } from "@/invitations/format";
import { renderWithIntl } from "@/test/intl";

import { renderWidgets, type HomeScope, type PersonalScope } from "./widget-content";

interface State {
  locale: "en" | "nl";
  notifications: { status: "ok"; value: unknown[] } | { status: "unavailable" };
  directory:
    { status: "ok"; members: unknown[] } | { status: "not-found" } | { status: "unavailable" };
}
const state = vi.hoisted((): State => ({
  locale: "en",
  notifications: { status: "ok", value: [] },
  directory: { status: "ok", members: [] },
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
vi.mock("@/notifications/server", () => ({
  listNotifications: () => Promise.resolve(state.notifications),
}));
vi.mock("@/members/directory", () => ({
  getHomeDirectory: () => Promise.resolve(state.directory),
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const LEFT_HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0002";
const WIDGET_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0200";

const formats: DateTimeFormats = {
  timeZone: "Europe/Brussels",
  dateFormat: "ymd-dash",
  timeFormat: "24h",
  locale: "en",
};

function personalScope(overrides: Partial<PersonalScope> = {}): PersonalScope {
  return {
    kind: "personal",
    displayName: null,
    formats,
    timeZoneIsFallback: false,
    homes: [{ id: HOME_ID, name: "Thuis", timeZone: "UTC", role: "member" }],
    ...overrides,
  };
}

function homeScope(permissions: Partial<HomePermissionProjection> = {}): HomeScope {
  return {
    kind: "home",
    home: { id: HOME_ID, name: "Thuis", timeZone: "America/New_York" },
    permissions: { "home.invitations.manage": false, ...permissions } as HomePermissionProjection,
    formats,
  };
}

/** Widget bodies are async server components: run them, like the server render would. */
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === "function") {
    const render = element.type as (props: Record<string, unknown>) => unknown;
    const output = render(element.props);
    if (output instanceof Promise) return resolve((await output) as ReactNode);
  }
  return node;
}

async function show(entries: readonly WidgetEntry[]): Promise<void> {
  const bodies = await Promise.all(entries.map((entry) => resolve(entry.body)));
  renderWithIntl(
    <div>
      {entries.map((entry, index) => (
        <section key={entry.id} aria-label={entry.title}>
          {bodies[index]}
        </section>
      ))}
    </div>,
    state.locale,
  );
}

function withHomeWidget(homeId: string): DashboardLayout {
  return addWidget(personalStarterLayout, {
    id: WIDGET_ID,
    type: "home-members",
    hidden: false,
    config: { showRoles: true },
    source: { homeId },
  });
}

beforeEach(() => {
  state.locale = "en";
  state.notifications = { status: "ok", value: [] };
  state.directory = { status: "ok", members: [] };
  vi.useFakeTimers({ toFake: ["Date"] });
  // 31 December 2026, 23:30 UTC: already 1 January 2027 in Brussels.
  vi.setSystemTime(new Date(Date.UTC(2026, 11, 31, 23, 30)));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("renderWidgets on the personal dashboard", () => {
  it("greets a new adult and shows today's date in their timezone and format", async () => {
    await show(await renderWidgets(personalStarterLayout, personalScope()));
    expect(screen.getByText("Welcome to Madeora")).toBeInTheDocument();
    const today = screen.getByTestId("today");
    expect(today).toHaveTextContent("Friday 2027-01-01");
    expect(today).toHaveAttribute("dateTime", "2027-01-01");
  });

  it("greets by display name, isolated so a right-to-left name cannot reorder the sentence", async () => {
    await show(await renderWidgets(personalStarterLayout, personalScope({ displayName: "שרה" })));
    expect(screen.getByText("Welcome, ⁨שרה⁩")).toBeInTheDocument();
  });

  it("says which timezone the date is in while the device has not reported one", async () => {
    await show(
      await renderWidgets(personalStarterLayout, personalScope({ timeZoneIsFallback: true })),
    );
    expect(
      screen.getByText(/\(in Europe\/Brussels, until this device reports its timezone\)/),
    ).toBeInTheDocument();
  });

  it("has truthful empty states and personal quick actions", async () => {
    await show(await renderWidgets(personalStarterLayout, personalScope()));
    const actions = screen.getByRole("region", { name: "Quick actions" });
    expect(within(actions).getByRole("link", { name: "Create a Home" })).toHaveAttribute(
      "href",
      "/homes/new",
    );
    expect(within(actions).getByRole("link", { name: "Trash" })).toHaveAttribute(
      "href",
      "/settings/trash",
    );
    const notifications = screen.getByRole("region", { name: "Notifications" });
    expect(within(notifications).getByText("No notifications")).toBeInTheDocument();
  });

  it("shows only as many notifications as the widget is set to", async () => {
    state.notifications = {
      status: "ok",
      value: Array.from({ length: 6 }, (_, index) => ({
        id: `n${String(index)}`,
        kind: "join_request.decided",
        homeId: null,
        homeName: null,
        objectionEndsAt: null,
        decision: "approved",
        duringQuietHours: false,
        createdAt: "2026-12-30T10:00:00Z",
        readAt: index === 0 ? null : "2026-12-30T11:00:00Z",
      })),
    };
    const layout: DashboardLayout = {
      ...personalStarterLayout,
      widgets: personalStarterLayout.widgets.map((w) =>
        w.type === "notifications" ? { ...w, config: { count: 3 } } : w,
      ),
    };
    await show(await renderWidgets(layout, personalScope()));
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(3);
    expect(within(region).getByText("Unread.")).toBeInTheDocument();
  });

  it("shows an error in one widget without breaking the others", async () => {
    state.notifications = { status: "unavailable" };
    await show(await renderWidgets(personalStarterLayout, personalScope()));
    expect(
      within(screen.getByRole("region", { name: "Notifications" })).getByText(
        "Couldn't load this widget",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Welcome to Madeora")).toBeInTheDocument();
  });

  it("labels a Home widget with its Home everywhere", async () => {
    state.directory = {
      status: "ok",
      members: [
        {
          membershipId: "m1",
          role: "owner",
          joinedAt: "2026-01-01T00:00:00Z",
          isSelf: true,
          name: "Sam",
          accentColor: null,
          avatarFileId: null,
        },
      ],
    };
    const entries = await renderWidgets(withHomeWidget(HOME_ID), personalScope());
    const entry = entries.find((e) => e.id === WIDGET_ID);
    expect(entry).toMatchObject({
      title: "Home members · ⁨Thuis⁩",
      sourceName: "Thuis",
      unavailable: false,
    });
    await show(entries);
    const region = screen.getByRole("region", { name: "Home members · ⁨Thuis⁩" });
    expect(within(region).getByText("⁨Sam⁩ (you)")).toBeInTheDocument();
    expect(within(region).getByText("Owner")).toBeInTheDocument();
  });

  it("shows a widget for a Home the person left as unavailable, without the Home's name or data", async () => {
    const entries = await renderWidgets(withHomeWidget(LEFT_HOME), personalScope());
    const entry = entries.find((e) => e.id === WIDGET_ID);
    expect(entry).toMatchObject({
      title: "Widget unavailable",
      sourceName: null,
      unavailable: true,
    });
    await show(entries);
    expect(screen.getAllByText("Widget unavailable").length).toBeGreaterThan(0);
  });
});

describe("renderWidgets on a Home dashboard", () => {
  it("welcomes to the Home with the Home's timezone", async () => {
    await show(await renderWidgets(homeStarterLayout, homeScope()));
    expect(screen.getByText("Welcome to ⁨Thuis⁩")).toBeInTheDocument();
    expect(screen.getByTestId("today")).toHaveAttribute("data-time-zone", "America/New_York");
    expect(screen.getByText(/the Home's timezone/)).toBeInTheDocument();
  });

  it("offers Invite people only to people who may manage invitations", async () => {
    await show(await renderWidgets(homeStarterLayout, homeScope()));
    expect(screen.queryByRole("link", { name: "Invite people" })).not.toBeInTheDocument();
  });

  it("links to invitations for invitation managers", async () => {
    await show(
      await renderWidgets(homeStarterLayout, homeScope({ "home.invitations.manage": true })),
    );
    expect(screen.getByRole("link", { name: "Invite people" })).toHaveAttribute(
      "href",
      `/homes/${HOME_ID}/invitations`,
    );
  });

  it("shows nothing of the Home when its directory cannot be read", async () => {
    state.directory = { status: "not-found" };
    await show(await renderWidgets(homeStarterLayout, homeScope()));
    expect(
      within(screen.getByRole("region", { name: "Home members" })).getByText(
        "Couldn't load this widget",
      ),
    ).toBeInTheDocument();
  });
});
