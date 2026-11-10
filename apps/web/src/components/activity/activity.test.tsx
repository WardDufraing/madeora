import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { parseActivityFilters } from "@/activity/filters";
import type { ActivityEntryView, ActivityPage } from "@/activity/server";
import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { ActivityList } from "./activity-list";
import { SecurityAlertsSetting } from "./security-alerts-setting";
import { SecurityReportSetting } from "./security-report-setting";

vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const { default: en } = await import("@/i18n/messages/en.json");
  return {
    getTranslations: (namespace: string) =>
      Promise.resolve(
        createTranslator({ locale: "en", messages: en, namespace: namespace as "Activity" }),
      ),
  };
});
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const reauthenticate = vi.fn();
vi.mock("@/auth/reauthenticate", () => ({
  reauthenticate: (...args: unknown[]) => reauthenticate(...args) as unknown,
}));

const fetchMock = vi.fn<typeof fetch>();
const formats = {
  timeZone: "Europe/Brussels",
  dateFormat: "dmy-slash",
  timeFormat: "24h",
  locale: "en",
} as const;
const ID_A = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";
const ID_B = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f02";
const REPORT = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f03";

function nth(items: readonly HTMLElement[], index: number): HTMLElement {
  const item = items[index];
  if (!item) throw new Error(`no item ${String(index)}`);
  return item;
}

function entry(overrides: Partial<ActivityEntryView> = {}): ActivityEntryView {
  return {
    id: ID_A,
    category: "security",
    kind: "signed_in",
    outcome: "completed",
    homeName: null,
    isCurrentMember: false,
    actor: "self",
    roles: null,
    device: { kind: "phone", browser: "safari", platform: "ios" },
    isCurrentSession: false,
    sessionLive: true,
    alerted: true,
    response: null,
    createdAt: "2026-11-07T09:30:00Z",
    ...overrides,
  };
}

async function list(page: ActivityPage | null, params: Record<string, string> = {}, paged = false) {
  const element = await ActivityList({
    path: "/settings/activity",
    page,
    filters: parseActivityFilters(params),
    paged,
    formats,
  });
  return renderWithIntl(element);
}

beforeEach(() => {
  vi.resetAllMocks();
  reauthenticate.mockResolvedValue(null);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ActivityList", () => {
  it("shows each entry with its result, time, Home, safe actor and device", async () => {
    const { container } = await list({
      entries: [
        entry(),
        entry({
          id: ID_B,
          category: "home_memberships",
          kind: "home_membership.role_changed",
          actor: "home_manager",
          homeName: "Maple House",
          isCurrentMember: true,
          roles: { from: "member", to: "administrator" },
          device: null,
        }),
      ],
      next: { createdAt: "2026-11-07T09:00:00+00:00", id: ID_B },
    });
    const items = within(screen.getByRole("list", { name: "Activity, newest first" })).getAllByRole(
      "listitem",
    );
    expect(items).toHaveLength(2);
    expect(within(nth(items, 0)).getByText("Signed in")).toBeInTheDocument();
    expect(within(nth(items, 0)).getByText("Safari on iPhone")).toBeInTheDocument();
    expect(within(nth(items, 0)).getByText("Alert sent")).toBeInTheDocument();
    expect(within(nth(items, 0)).getByText("07/11/2026 10:30")).toBeInTheDocument();
    expect(within(nth(items, 1)).getByText("By a Home manager")).toBeInTheDocument();
    expect(within(nth(items, 1)).getByText("From Member to Administrator")).toBeInTheDocument();
    expect(within(nth(items, 1)).getByText(/Maple House/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Older entries" })).toHaveAttribute(
      "href",
      `/settings/activity?before=2026-11-07T09%3A00%3A00%2B00%3A00&beforeId=${ID_B}`,
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it("says when a Home is no longer the person's", async () => {
    await list({
      entries: [
        entry({
          kind: "home_membership.removed",
          homeName: "Oak",
          device: null,
          isCurrentMember: false,
        }),
      ],
      next: null,
    });
    expect(screen.getByText(/you're no longer a member/)).toBeInTheDocument();
  });

  it("distinguishes empty, no match and unavailable", async () => {
    const { unmount } = await list({ entries: [], next: null });
    expect(screen.getByText("No activity yet")).toBeInTheDocument();
    unmount();
    const second = await list({ entries: [], next: null }, { q: "zzz" });
    expect(screen.getByText("Nothing matches these filters")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute(
      "href",
      "/settings/activity",
    );
    second.unmount();
    await list(null);
    expect(screen.getByText("Your activity couldn't be loaded")).toBeInTheDocument();
  });

  it("answers a sign-in with This was me", async () => {
    fetchMock.mockResolvedValue(Response.json({ result: "confirmed" }));
    await list({ entries: [entry()], next: null });
    await userEvent.click(screen.getByRole("button", { name: "This was me" }));
    expect(await screen.findByText("Thanks, this sign-in is marked as yours.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/me/activity/${ID_A}/response`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ response: "confirmed" }) }),
    );
  });

  it("secures the account and points to the controls", async () => {
    fetchMock.mockResolvedValue(Response.json({ result: "signed_out" }));
    await list({ entries: [entry()], next: null });
    await userEvent.click(screen.getByRole("button", { name: "Secure my account" }));
    expect(await screen.findByText(/That session was signed out and reported/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Change password" })).toHaveAttribute(
      "href",
      "/settings/security#password",
    );
  });

  it("shows an earlier answer instead of the buttons", async () => {
    await list({ entries: [entry({ response: "reported" })], next: null });
    expect(screen.getByText("You reported this sign-in.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "This was me" })).not.toBeInTheDocument();
  });
});

describe("SecurityAlertsSetting", () => {
  it("saves the routine choices", async () => {
    fetchMock.mockResolvedValue(Response.json({}));
    const { container } = renderWithIntl(<SecurityAlertsSetting newDevice everySignIn={false} />);
    expect(screen.getByRole("checkbox", { name: /Sign-ins from a new device/ })).toBeChecked();
    await userEvent.click(screen.getByRole("checkbox", { name: /Every sign-in/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Your choices were saved.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/me/security-alerts",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ newDevice: true, everySignIn: true }),
      }),
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it("says when saving failed", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "failed" }, { status: 500 }));
    renderWithIntl(<SecurityAlertsSetting newDevice everySignIn={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText("Your choices couldn't be saved. Try again."),
    ).toBeInTheDocument();
  });
});

describe("SecurityReportSetting", () => {
  const props = {
    email: "ann@example.com",
    userId: "user-1",
    twoFactor: false,
    hasPassword: true,
    confirmed: null,
    timeZone: "Europe/Brussels",
    today: "2026-11-07",
    earliest: "2025-11-08",
    defaultFrom: "2026-10-08",
  } as const;

  it("asks to confirm it's you, then prepares the report", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: "reauthentication-required" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ id: REPORT }, { status: 201 }));
    const { container } = renderWithIntl(<SecurityReportSetting {...props} reports={[]} />);
    expect(await axeViolations(container)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Prepare report" }));
    const confirm = await screen.findByRole("form", {
      name: "Confirm it's you to prepare the report.",
    });
    await userEvent.type(within(confirm).getByLabelText(/password/i), "correct horse");
    await userEvent.click(within(confirm).getByRole("button", { name: "Prepare report" }));
    expect(await screen.findByText("Your report is ready to download.")).toBeInTheDocument();
    expect(reauthenticate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/me/security-reports",
      expect.objectContaining({
        body: JSON.stringify({ from: "2026-10-08", to: "2026-11-07", timeZone: "Europe/Brussels" }),
      }),
    );
  });

  it("refuses a range outside retention before asking anything", async () => {
    renderWithIntl(<SecurityReportSetting {...props} defaultFrom="2024-01-01" reports={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "Prepare report" }));
    expect(await screen.findByText(/Choose dates within the last 12 months/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads a ready report and says when the limit is reached", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("a,b\r\n", {
        headers: { "content-disposition": 'attachment; filename="madeora-security-report.csv"' },
      }),
    );
    const createObjectURL = vi.fn(() => "blob:report");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    renderWithIntl(
      <SecurityReportSetting
        {...props}
        reports={[
          {
            id: REPORT,
            range: "08/10/2026 to 07/11/2026",
            status: "ready",
            expires: "08/11/2026 10:00",
            downloaded: null,
          },
          {
            id: ID_A,
            range: "01/10/2026 to 02/10/2026",
            status: "expired",
            expires: "",
            downloaded: null,
          },
        ]}
      />,
    );
    expect(screen.getByText("Expired")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Download the report for 08/10/2026 to 07/11/2026 as CSV",
      }),
    );
    await waitFor(() => {
      expect(createObjectURL).toHaveBeenCalled();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/me/security-reports/${REPORT}/download`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ format: "csv" }) }),
    );

    fetchMock.mockResolvedValueOnce(Response.json({ error: "rate-limited" }, { status: 429 }));
    await userEvent.click(screen.getByRole("button", { name: "Prepare report" }));
    expect(await screen.findByText(/You can prepare 3 reports a day/)).toBeInTheDocument();
  });
});
