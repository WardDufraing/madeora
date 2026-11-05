// S33: a Google calendar behind a calendar view that is not up to date is never shown as synced. The
// owner reads the reason and is offered the settings; someone else's shared calendar shows only that
// it is not up to date and when it last synced.
import { screen } from "@testing-library/react";

import type { GoogleWarning } from "@/google-calendar/shapes";
import { axeViolations } from "@/test/axe";
import { renderWithIntl } from "@/test/intl";

import { GoogleWarnings } from "./google-warnings";

const OWNER = "0c0a0000-0000-4000-8000-000000000009";
const formats = {
  timeZone: "Europe/Brussels",
  dateFormat: "dmy-slash",
  timeFormat: "24h",
  locale: "en",
} as const;

function show(warnings: GoogleWarning[], compact = false) {
  return renderWithIntl(
    <GoogleWarnings
      warnings={warnings}
      names={new Map([[OWNER, "Sam"]])}
      formats={formats}
      compact={compact}
    />,
  );
}

describe("GoogleWarnings", () => {
  it("shows nothing when every calendar is up to date", () => {
    const { container } = show([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the owner's expired calendar, its last sync and the way to fix it", async () => {
    const { container } = show([
      {
        calendar: "Work",
        own: true,
        sharedBy: null,
        state: "authorization_expired",
        lastSyncedAt: "2026-11-04T08:30:00Z",
      },
    ]);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Work: Google access expired; events are not updated.");
    expect(status).toHaveTextContent("Last synced 04/11/2026 09:30.");
    expect(screen.getByRole("link", { name: "Open Google Calendar settings" })).toHaveAttribute(
      "href",
      "/settings/google-calendar",
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it("tells a Home member only that a shared calendar is not up to date, and offers no settings", () => {
    show([
      { calendar: "Club", own: false, sharedBy: OWNER, state: "out_of_date", lastSyncedAt: null },
    ]);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Club (shared by Sam): Not up to date. Not synced yet.",
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("is short in the widget", () => {
    show(
      [
        {
          calendar: "Work",
          own: true,
          sharedBy: null,
          state: "stale",
          lastSyncedAt: "2026-11-04T08:30:00Z",
        },
      ],
      true,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Work: Not updated recently.");
    expect(screen.getByRole("status")).not.toHaveTextContent("Last synced");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
