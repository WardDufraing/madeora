import { screen } from "@testing-library/react";

import { renderWithIntl } from "@/test/intl";

import { NotificationBell } from "./notification-bell";

describe("NotificationBell", () => {
  it("links to the notification centre and says how many are unread", () => {
    renderWithIntl(<NotificationBell unread={3} />);
    const link = screen.getByRole("link", { name: "Notifications: 3 unread" });
    expect(link).toHaveAttribute("href", "/notifications");
    expect(screen.getByTestId("notification-count")).toHaveTextContent("3");
  });

  it("shows no number when everything is read, and caps a long count", () => {
    const { unmount } = renderWithIntl(<NotificationBell unread={0} />);
    expect(screen.getByRole("link", { name: "Notifications" })).toBeVisible();
    expect(screen.queryByTestId("notification-count")).toBeNull();
    unmount();
    renderWithIntl(<NotificationBell unread={250} />);
    expect(screen.getByTestId("notification-count")).toHaveTextContent("99+");
  });
});
