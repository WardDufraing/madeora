import { notificationKinds } from "@madeora/domain/notifications";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { NotificationView } from "@/notifications/types";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { messageKeyFor, NotificationList } from "./notification-list";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const { default: en } = await import("@/i18n/messages/en.json");
  return {
    getTranslations: (namespace: string) =>
      Promise.resolve(
        createTranslator({ locale: "en", messages: en, namespace: namespace as "Notifications" }),
      ),
  };
});

const fetchMock = vi.fn<typeof fetch>();
const bodyText = (body: BodyInit | null | undefined): string =>
  typeof body === "string" ? body : "null";
const formats = {
  timeZone: "UTC",
  dateFormat: "dmy-slash",
  timeFormat: "24h",
  locale: "en",
} as const;
const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";

function item(overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a1",
    kind: "recovery.claimant_paused",
    homeId: HOME_ID,
    homeName: "Thuis",
    objectionEndsAt: null,
    decision: null,
    duringQuietHours: false,
    createdAt: "2026-10-15T10:00:00Z",
    readAt: null,
    ...overrides,
  };
}

async function show(items: readonly NotificationView[]) {
  const element = await NotificationList({ items, formats });
  return renderWithQuery(<>{element}</>);
}

beforeEach(() => {
  fetchMock.mockReset();
  router.refresh.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("messageKeyFor", () => {
  it("has a message for every kind the database writes", () => {
    for (const kind of notificationKinds) {
      expect(messageKeyFor({ kind, decision: null }), kind).not.toBe("kindUnknown");
    }
  });

  it("picks the join request message by its decision, and falls back for unknown kinds", () => {
    expect(messageKeyFor({ kind: "join_request.decided", decision: "declined" })).toBe(
      "kindJoinRequestDeclined",
    );
    expect(messageKeyFor({ kind: "join_request.decided", decision: "approved" })).toBe(
      "kindJoinRequestApproved",
    );
    expect(messageKeyFor({ kind: "chores.assigned", decision: null })).toBe("kindUnknown");
  });
});

describe("NotificationList", () => {
  it("says there is nothing yet", async () => {
    const { container } = await show([]);
    expect(screen.getByTestId("notifications-empty")).toHaveTextContent("no notifications yet");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows the sentence, its source Home, the time and unread state", async () => {
    const { container } = await show([
      item(),
      item({ id: "b", readAt: "2026-10-15T11:00:00Z", kind: "recovery.claimant_rejected" }),
    ]);
    const [unread, read] = screen.getAllByTestId("notification");
    expect(unread).toHaveAttribute("data-unread", "true");
    expect(unread).toHaveTextContent("Unread.");
    expect(unread).toHaveTextContent("Your ownership request for ⁨Thuis⁩ is paused.");
    expect(unread).toHaveTextContent("From ⁨Thuis⁩");
    expect(unread).toHaveTextContent("15/10/2026 10:00");
    expect(read).toHaveAttribute("data-unread", "false");
    expect(within(read as HTMLElement).queryByRole("button")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("formats the objection end in the viewer's timezone and marks quiet-hours arrivals", async () => {
    await show([
      item({
        kind: "recovery.member_objection_open",
        objectionEndsAt: "2026-10-29T16:00:00Z",
        duringQuietHours: true,
      }),
    ]);
    const row = screen.getByTestId("notification");
    expect(row).toHaveTextContent("You can object until 29/10/2026 16:00.");
    expect(row).toHaveTextContent("Arrived during your quiet hours");
  });

  it("links to the page the notification is about", async () => {
    await show([item({ kind: "recovery.claimant_ready" })]);
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      `/homes/${HOME_ID}/recovery`,
    );
  });

  it("copes with a Home that is gone and a kind it does not know", async () => {
    await show([item({ kind: "chores.assigned", homeId: null, homeName: null })]);
    const row = screen.getByTestId("notification");
    expect(row).toHaveTextContent("Something happened in a Home.");
    expect(within(row).queryByText(/^From/)).toBeNull();
  });

  it("marks one notification read through the API and refreshes", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(
      Promise.resolve(new Response(JSON.stringify({ updated: 1 }), { status: 200 })),
    );
    await show([item()]);
    await user.click(screen.getByRole("button", { name: /Mark as read: / }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    // The button goes away with the refresh, so focus moves to the row first.
    expect(screen.getByTestId("notification")).toHaveFocus();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/me/notifications/read");
    expect(JSON.parse(bodyText(init?.body))).toEqual({ ids: [item().id] });
  });

  it("marks everything read, announcing it", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(
      Promise.resolve(new Response(JSON.stringify({ updated: 2 }), { status: 200 })),
    );
    await show([item(), item({ id: "b" })]);
    await user.click(screen.getByRole("button", { name: "Mark all as read" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "All notifications are marked as read.",
    );
    expect(JSON.parse(bodyText(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ all: true });
  });

  it("says when marking failed", async () => {
    const user = userEvent.setup();
    fetchMock.mockReturnValue(Promise.resolve(new Response("{}", { status: 500 })));
    await show([item()]);
    await user.click(screen.getByRole("button", { name: /Mark as read: / }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not mark as read");
  });

  it("offers no mark-all button when everything is read", async () => {
    await show([item({ readAt: "2026-10-15T11:00:00Z" })]);
    expect(screen.queryByRole("button", { name: "Mark all as read" })).toBeNull();
  });
});
