import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { PreferenceRow, QuietHoursRow } from "@/notifications/types";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { NotificationSettings, type NotificationSettingsProps } from "./notification-settings";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const fetchMock = vi.fn<typeof fetch>();
const bodyText = (body: BodyInit | null | undefined): string =>
  typeof body === "string" ? body : "null";
const ok = () => Promise.resolve(new Response("{}", { status: 200 }));
const bodyOf = (index = 0): unknown =>
  JSON.parse(bodyText(fetchMock.mock.calls[index]?.[1]?.body)) as unknown;

const HOME_A = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const HOME_B = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0002";

function rows(
  scope: string | null,
  inApp: [boolean, boolean],
  email: [boolean, boolean],
): PreferenceRow[] {
  return [
    {
      homeId: scope,
      category: "invitations",
      channel: "in_app",
      enabled: inApp[0],
      overridden: inApp[1],
    },
    {
      homeId: scope,
      category: "invitations",
      channel: "email",
      enabled: email[0],
      overridden: email[1],
    },
  ];
}

function props(overrides: Partial<NotificationSettingsProps> = {}): NotificationSettingsProps {
  return {
    account: { id: null, name: "Your defaults", suggestedTimeZone: "Europe/Brussels" },
    homes: [
      { id: HOME_A, name: "Thuis", suggestedTimeZone: "Europe/Brussels" },
      { id: HOME_B, name: "Elders", suggestedTimeZone: "America/New_York" },
    ],
    zoneChoices: ["America/New_York", "Europe/Brussels", "UTC"],
    emailVerified: true,
    preferences: [
      ...rows(null, [true, false], [true, true]),
      ...rows(HOME_A, [true, false], [true, false]),
      ...rows(HOME_B, [true, false], [false, true]),
    ],
    quietHours: [],
    ...overrides,
  };
}

function scope(name: string): HTMLElement {
  return screen.getByRole("group", { name });
}

/** One scope's invitations choices. */
function invitations(name: string): HTMLElement {
  return within(scope(name)).getByRole("group", { name: "Invitations and join requests" });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(ok);
  router.refresh.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NotificationSettings", () => {
  it("says security messages are always on, and has no switch for them", async () => {
    const { container } = renderWithQuery(<NotificationSettings {...props()} />);
    expect(screen.getByRole("heading", { name: "Security and recovery messages" })).toBeVisible();
    expect(screen.getByText(/always on/)).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows, per scope, what is inherited and what is overridden", () => {
    renderWithQuery(<NotificationSettings {...props()} />);
    expect(
      within(invitations("Your defaults")).getByTestId("notification-status"),
    ).toHaveTextContent("Your choice");
    expect(within(invitations("Thuis")).getByTestId("notification-status")).toHaveTextContent(
      "Inherited from your defaults",
    );
    expect(within(invitations("Elders")).getByTestId("notification-status")).toHaveTextContent(
      "Set for this Home",
    );
  });

  it("previews what is effective in plain words", () => {
    renderWithQuery(<NotificationSettings {...props()} />);
    expect(within(scope("Thuis")).getByTestId("notification-preview")).toHaveTextContent(
      "arrive in the app and by email",
    );
    expect(within(scope("Elders")).getByTestId("notification-preview")).toHaveTextContent(
      "arrive in the app only",
    );
  });

  it("saves a Home override when a box is changed, and refreshes the page", async () => {
    const user = userEvent.setup();
    renderWithQuery(<NotificationSettings {...props()} />);
    await user.click(within(invitations("Thuis")).getByRole("checkbox", { name: "By email" }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/me/notifications/preferences");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(bodyOf()).toEqual({
      homeId: HOME_A,
      category: "invitations",
      channel: "email",
      enabled: false,
    });
  });

  it("saves an account default with homeId null", async () => {
    const user = userEvent.setup();
    renderWithQuery(<NotificationSettings {...props()} />);
    await user.click(
      within(invitations("Your defaults")).getByRole("checkbox", { name: "In the app" }),
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(bodyOf()).toEqual({
      homeId: null,
      category: "invitations",
      channel: "in_app",
      enabled: false,
    });
  });

  it("resets a Home's overrides, only the ones that are set", async () => {
    const user = userEvent.setup();
    renderWithQuery(<NotificationSettings {...props()} />);
    expect(
      within(invitations("Thuis")).queryByRole("button", { name: "Use my defaults" }),
    ).toBeNull();
    await user.click(
      within(invitations("Elders")).getByRole("button", { name: "Use my defaults" }),
    );
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/me/notifications/preferences/reset");
    expect(bodyOf()).toEqual({ homeId: HOME_B, category: "invitations", channel: "email" });
  });

  it("will not turn email on while the address is unconfirmed, and says why", () => {
    renderWithQuery(
      <NotificationSettings
        {...props({
          emailVerified: false,
          preferences: [...rows(null, [true, false], [false, false])],
          homes: [],
        })}
      />,
    );
    const email = within(invitations("Your defaults")).getByRole("checkbox", { name: "By email" });
    expect(email).toBeDisabled();
    expect(email).toHaveAccessibleDescription(/once your address is confirmed/);
  });

  it("reports a failed save and a Home the person has left", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValueOnce(Promise.resolve(new Response("{}", { status: 404 })));
    renderWithQuery(<NotificationSettings {...props()} />);
    await user.click(within(invitations("Thuis")).getByRole("checkbox", { name: "In the app" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You no longer belong to this Home.",
    );
  });

  it("has its own choices for task reminders, in the app by default", async () => {
    const user = userEvent.setup();
    renderWithQuery(<NotificationSettings {...props()} />);
    const reminders = within(
      within(scope("Thuis")).getByRole("group", { name: "Task and chore reminders" }),
    );
    expect(reminders.getByRole("checkbox", { name: "In the app" })).toBeChecked();
    expect(reminders.getByRole("checkbox", { name: "By email" })).not.toBeChecked();
    expect(within(scope("Thuis")).getByTestId("notification-preview")).toHaveTextContent(
      "Task and chore reminders arrive in the app only.",
    );
    await user.click(reminders.getByRole("checkbox", { name: "By email" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(bodyOf()).toEqual({
      homeId: HOME_A,
      category: "reminders",
      channel: "email",
      enabled: true,
    });
  });

  it("says when there is no Home", () => {
    renderWithQuery(<NotificationSettings {...props({ homes: [] })} />);
    expect(screen.getByText("You do not belong to a Home yet.")).toBeVisible();
  });
});

describe("quiet hours", () => {
  const quiet: QuietHoursRow = {
    homeId: null,
    enabled: true,
    start: "22:00",
    end: "07:00",
    timeZone: "Europe/Brussels",
  };

  it("prefills the suggested zone and the usual night, off", () => {
    renderWithQuery(<NotificationSettings {...props()} />);
    const elders = within(scope("Elders"));
    expect(elders.getByRole("combobox", { name: /Time zone/ })).toHaveValue("America/New_York");
    expect(elders.getByLabelText("From")).toHaveValue("22:00");
    expect(elders.getByLabelText("Until")).toHaveValue("07:00");
    expect(elders.getByRole("checkbox", { name: "Use quiet hours" })).not.toBeChecked();
    expect(elders.getByTestId("notification-preview")).toHaveTextContent("Quiet hours are off.");
  });

  it("shows inherited quiet hours in a Home and what they mean", () => {
    renderWithQuery(<NotificationSettings {...props({ quietHours: [quiet] })} />);
    const thuis = within(scope("Thuis"));
    expect(thuis.getByRole("checkbox", { name: "Use quiet hours" })).toBeChecked();
    expect(thuis.getAllByText("Inherited from your defaults")).toHaveLength(5);
    expect(thuis.getByTestId("notification-preview")).toHaveTextContent(
      "Quiet hours: 22:00 to 07:00 (Europe/Brussels).",
    );
    expect(thuis.queryByRole("button", { name: "Use my default quiet hours" })).toBeNull();
  });

  it("saves quiet hours for one Home with its own zone", async () => {
    const user = userEvent.setup();
    renderWithQuery(<NotificationSettings {...props()} />);
    const elders = within(scope("Elders"));
    await user.click(elders.getByRole("checkbox", { name: "Use quiet hours" }));
    await user.click(elders.getByRole("button", { name: "Save quiet hours" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/me/notifications/quiet-hours");
    expect(bodyOf()).toEqual({
      homeId: HOME_B,
      enabled: true,
      start: "22:00",
      end: "07:00",
      timeZone: "America/New_York",
    });
  });

  it("refuses a window that starts and ends together, before sending anything", async () => {
    const user = userEvent.setup();
    renderWithQuery(<NotificationSettings {...props()} />);
    const elders = within(scope("Elders"));
    await user.clear(elders.getByLabelText("Until"));
    await user.type(elders.getByLabelText("Until"), "22:00");
    await user.click(elders.getByRole("button", { name: "Save quiet hours" }));
    expect(await elders.findByText("Choose a start and an end that differ.")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removes a Home's own quiet hours", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <NotificationSettings
        {...props({ quietHours: [quiet, { ...quiet, homeId: HOME_B, enabled: false }] })}
      />,
    );
    await user.click(
      within(scope("Elders")).getByRole("button", { name: "Use my default quiet hours" }),
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/me/notifications/quiet-hours/reset");
    expect(bodyOf()).toEqual({ homeId: HOME_B });
  });

  it("is accessible with quiet hours set", async () => {
    const { container } = renderWithQuery(
      <NotificationSettings {...props({ quietHours: [quiet] })} />,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
