import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { CalendarChoicesForm, DisconnectButton, SyncNowButton } from "./google-calendar-actions";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const CALENDAR = "0c0a0000-0000-4000-8000-000000000003";
const HOME = "0c0a0000-0000-4000-8000-000000000004";
const OTHER_HOME = "0c0a0000-0000-4000-8000-000000000005";

const fetchMock = vi.fn<typeof fetch>();
function answer(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}
function sent(index = 0): { url: string; method: string; body: unknown } {
  const [url, init] = fetchMock.mock.calls[index] ?? [];
  return {
    url: typeof url === "string" ? url : "",
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  router.refresh.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SyncNowButton", () => {
  it("queues a sync and refreshes the page", async () => {
    answer(200, { outcome: "queued" });
    renderWithQuery(<SyncNowButton disabled={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(sent()).toEqual({
      url: "/api/v1/integrations/google-calendar/sync",
      method: "POST",
      body: {},
    });
  });

  it("says when the last sync was less than a minute ago", async () => {
    answer(429, { error: "too-soon" });
    renderWithQuery(<SyncNowButton disabled={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("less than a minute ago");
  });
});

describe("DisconnectButton", () => {
  it("asks first, then disconnects", async () => {
    answer(200, { outcome: "disconnected", revoked: true });
    renderWithQuery(<DisconnectButton />);
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(screen.getByText(/removes every synced Google event/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Disconnect and remove events" }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(sent().method).toBe("DELETE");
  });

  it("can be cancelled", async () => {
    renderWithQuery(<DisconnectButton />);
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("points to Google's permissions page when the access could not be withdrawn", async () => {
    answer(200, { outcome: "disconnected", revoked: false });
    renderWithQuery(<DisconnectButton />);
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect and remove events" }));
    const link = await screen.findByRole("link", { name: /your Google account permissions/ });
    expect(link).toHaveAttribute("href", "https://myaccount.google.com/permissions");
  });
});

describe("CalendarChoicesForm", () => {
  const homes = [
    { id: HOME, name: "Family" },
    { id: OTHER_HOME, name: "Club" },
  ];

  function renderForm(overrides: Partial<Parameters<typeof CalendarChoicesForm>[0]> = {}) {
    return renderWithQuery(
      <CalendarChoicesForm
        calendarId={CALENDAR}
        name="Work"
        sync
        showPersonal
        shared={[]}
        homes={homes}
        canSync
        {...overrides}
      />,
    );
  }

  it("shares with only the Homes chosen", async () => {
    answer(200, { outcome: "saved" });
    renderForm();
    await userEvent.click(screen.getByRole("checkbox", { name: "Family" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(sent()).toEqual({
      url: `/api/v1/integrations/google-calendar/calendars/${CALENDAR}`,
      method: "PUT",
      body: { sync: true, showPersonal: true, homes: [HOME] },
    });
  });

  it("turning sync off shows the calendar nowhere", async () => {
    answer(200, { outcome: "saved" });
    renderForm({ shared: [HOME] });
    await userEvent.click(screen.getByRole("checkbox", { name: "Sync this calendar" }));
    expect(screen.getByRole("checkbox", { name: "Show on my personal calendar" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Family" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(sent().body).toEqual({ sync: false, showPersonal: false, homes: [] });
  });

  it("cannot start syncing past the limit, and explains a refused Home", async () => {
    answer(400, { error: "invalid-home" });
    renderForm({ sync: false, showPersonal: false, canSync: false });
    expect(screen.getByRole("checkbox", { name: "Sync this calendar" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer available");
  });

  it("has no accessibility violations", async () => {
    const { container } = renderForm();
    expect(await axeViolations(container)).toEqual([]);
  });
});
