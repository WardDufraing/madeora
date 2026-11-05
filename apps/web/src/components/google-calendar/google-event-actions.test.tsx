import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { GoogleChange } from "@/google-calendar/shapes";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { RestoreHiddenButton, WriteTargetForm } from "./google-calendar-actions";
import { GoogleChangePanel, GoogleEventActions } from "./google-event-actions";
import { GoogleEventForm } from "./google-event-form";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const EVENT = "0c0c0000-0000-4000-8000-000000000001";
const CHANGE = "0c0c0000-0000-4000-8000-000000000002";
const CALENDAR = "0c0c0000-0000-4000-8000-000000000003";

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
  router.push.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const conflict: GoogleChange = {
  id: CHANGE,
  action: "update",
  scope: "event",
  state: "conflict",
  errorCode: null,
  fields: ["title", "time"],
  conflictFields: ["title"],
  mine: { title: "Dentist (moved)" },
  theirs: { title: "Dentist at 10" },
  own: true,
};

describe("GoogleChangePanel", () => {
  it("shows both versions of a conflict and resolves only on the person's choice", async () => {
    answer(200, { outcome: "resolved" });
    const { container } = renderWithQuery(<GoogleChangePanel change={conflict} calendar="Work" />);
    const table = screen.getByRole("table");
    expect(within(table).getByText("Dentist (moved)")).toBeInTheDocument();
    expect(within(table).getByText("Dentist at 10")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await axeViolations(container)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Keep Google's version" }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(sent()).toEqual({
      url: `/api/v1/integrations/google-calendar/changes/${CHANGE}`,
      method: "POST",
      body: { action: "resolve", choice: "google" },
    });
  });

  it("says when Google deleted the event Madeora changed", () => {
    renderWithQuery(
      <GoogleChangePanel
        change={{ ...conflict, conflictFields: [], theirs: { deleted: true } }}
        calendar="Work"
      />,
    );
    expect(screen.getByText("Deleted in Google")).toBeInTheDocument();
  });

  it("offers Try again and Discard on a failed change", async () => {
    answer(200, { outcome: "queued" });
    renderWithQuery(
      <GoogleChangePanel change={{ ...conflict, state: "failed" }} calendar="Work" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(sent().body).toEqual({ action: "retry" });
    expect(screen.getByRole("button", { name: "Discard change" })).toBeInTheDocument();
  });

  it("says a change is waiting for Google", () => {
    renderWithQuery(
      <GoogleChangePanel change={{ ...conflict, state: "pending" }} calendar="Work" />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("waiting to be saved to Google");
  });
});

describe("GoogleEventActions", () => {
  const props = {
    homeId: null,
    eventId: EVENT,
    revision: 4,
    recurring: false,
    calendar: "Work",
    conflict: false,
    dateFormat: "dmy-slash" as const,
    editHref: `/calendar/google/${EVENT}/edit`,
  };

  it("asks where to delete and removes it from Madeora only", async () => {
    answer(200, { outcome: "removed" });
    renderWithQuery(<GoogleEventActions {...props} editable />);
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute("href", props.editHref);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByTestId("google-delete-dialog");
    const confirm = within(dialog).getByTestId("google-delete-confirm");
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByText(/Also deleted from “Work”/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("radio", { name: "Remove from Madeora" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove from Madeora" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith("/calendar");
    });
    expect(sent()).toEqual({
      url: `/api/v1/calendar/google-events/${EVENT}`,
      method: "DELETE",
      body: { scope: "event", destination: "madeora", revision: 4 },
    });
  });

  it("offers no Delete everywhere and no Edit in a read-only calendar", async () => {
    renderWithQuery(<GoogleEventActions {...props} editable={false} />);
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("radio", { name: "Delete everywhere" })).toBeDisabled();
  });

  it("lists the occurrences before deleting a series everywhere", async () => {
    answer(200, {
      outcome: "preview",
      count: 2,
      dates: ["2026-11-20", "2026-11-27"],
      beyondWindow: true,
    });
    answer(200, { outcome: "deleting" });
    renderWithQuery(<GoogleEventActions {...props} recurring editable />);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("radio", { name: "All events" }));
    await userEvent.click(screen.getByRole("radio", { name: "Delete everywhere" }));
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(
      await screen.findByText(/2 events are deleted from Madeora and Google/),
    ).toBeInTheDocument();
    expect(sent().body).toEqual({
      scope: "all",
      destination: "everywhere",
      revision: 4,
      dryRun: true,
    });
    await userEvent.click(screen.getByTestId("google-delete-confirm"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(sent(1).body).toEqual({ scope: "all", destination: "everywhere", revision: 4 });
  });

  it("hides Edit and Delete while a conflict waits", () => {
    renderWithQuery(<GoogleEventActions {...props} editable conflict />);
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
  });
});

describe("GoogleEventForm", () => {
  const values = {
    title: "Standup",
    location: "",
    description: "",
    allDay: false,
    startsOn: "2026-11-20",
    endsOn: "2026-11-20",
    startTime: "09:00",
    endTime: "09:15",
    timezone: "Europe/Brussels",
  };

  it("saves one event at once with its revision", async () => {
    answer(200, { outcome: "saved", revision: 5 });
    renderWithQuery(
      <GoogleEventForm
        eventId={EVENT}
        revision={4}
        recurring={false}
        values={values}
        timeZoneChoices={["Europe/Brussels"]}
        dateFormat="dmy-slash"
      />,
    );
    const title = screen.getByLabelText(/Title/);
    await userEvent.clear(title);
    await userEvent.type(title, "Standup (Room 2)");
    await userEvent.click(screen.getByTestId("google-event-save"));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(`/calendar/google/${EVENT}`);
    });
    expect(sent()).toMatchObject({
      method: "PATCH",
      body: { scope: "event", revision: 4, event: { title: "Standup (Room 2)" } },
    });
  });

  it("previews a change to all events first and keeps their dates", async () => {
    answer(200, { outcome: "preview", count: 3, dates: [], beyondWindow: true });
    answer(200, { outcome: "saved", revision: 5 });
    renderWithQuery(
      <GoogleEventForm
        eventId={EVENT}
        revision={4}
        recurring
        values={values}
        timeZoneChoices={["Europe/Brussels"]}
        dateFormat="dmy-slash"
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: "All events" }));
    expect(screen.getByLabelText(/Starts on/)).toHaveAttribute("readonly");
    await userEvent.click(screen.getByTestId("google-event-save"));
    expect(await screen.findByText(/3 events in Madeora change/)).toBeInTheDocument();
    expect(sent().body).toMatchObject({ scope: "all", dryRun: true });
    await userEvent.click(screen.getByTestId("google-event-confirm"));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalled();
    });
    expect(sent(1).body).toMatchObject({ scope: "all", event: { startsOn: "2026-11-20" } });
  });

  it("says why Google refused a stale change", async () => {
    answer(409, { error: "stale" });
    renderWithQuery(
      <GoogleEventForm
        eventId={EVENT}
        revision={4}
        recurring={false}
        values={values}
        timeZoneChoices={["Europe/Brussels"]}
        dateFormat="dmy-slash"
      />,
    );
    await userEvent.click(screen.getByTestId("google-event-save"));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed in the meantime");
  });
});

describe("settings: target and hidden events", () => {
  it("saves where new events go", async () => {
    answer(200, { outcome: "saved" });
    renderWithQuery(
      <WriteTargetForm current={null} calendars={[{ id: CALENDAR, name: "Family" }]} />,
    );
    await userEvent.selectOptions(screen.getByLabelText("New events go to"), CALENDAR);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(sent()).toEqual({
      url: "/api/v1/integrations/google-calendar/target",
      method: "PUT",
      body: { calendarId: CALENDAR },
    });
  });

  it("restores a hidden event", async () => {
    answer(200, { outcome: "restored" });
    renderWithQuery(<RestoreHiddenButton exclusionId={CHANGE} title="Dentist" />);
    await userEvent.click(screen.getByRole("button", { name: "Restore Dentist" }));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(sent().method).toBe("DELETE");
  });
});
