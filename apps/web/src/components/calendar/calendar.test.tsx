// S32: the calendar in the interface. The database decides every right (tests/db/rls/calendar.test.sql);
// these tests check what people read in en and nl, what is sent, that every recurring change and
// deletion shows what it affects before anything happens, and that the views pass automated checks.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  EVENT,
  HOME,
  MEMBERSHIP,
  OTHER_HOME,
  OTHER_MEMBERSHIP,
  eventDetail,
} from "@/calendar/testing";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { CalendarAccessForm } from "./calendar-access-form";
import { EventActions } from "./event-actions";
import { EventForm } from "./event-form";
import { ShareForm } from "./share-form";
import { CalendarToggles } from "./calendar-toggles";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/calendar" }));

const fetchMock = vi.fn<typeof fetch>();
const urlOf = (input: RequestInfo | URL | undefined): string =>
  input === undefined
    ? ""
    : typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
const reply = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
function sent(part: string, method: string): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => urlOf(input).includes(part) && (init?.method ?? "GET") === method)
    .map(([, init]) =>
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    );
}

const zones = ["Europe/Brussels", "Europe/London", "UTC"];
const members = [
  { id: MEMBERSHIP, name: "Ward", isSelf: true },
  { id: OTHER_MEMBERSHIP, name: "Sam", isSelf: false },
];
const homes = [
  { id: HOME, name: "Dufraing" },
  { id: OTHER_HOME, name: "Studio" },
];

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => reply(201, { outcome: "created", id: EVENT, revision: 1 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
  router.push.mockClear();
});

describe("the event form", () => {
  it("adds a personal event shared with a Home, in the person's timezone", async () => {
    const user = userEvent.setup();
    const { container } = renderWithQuery(
      <EventForm
        homeId={null}
        defaultTimeZone="Europe/Brussels"
        timeZoneChoices={zones}
        members={[]}
        homes={homes}
        dateFormat="dmy-slash"
        initialDate="2026-11-10"
      />,
    );
    expect(await axeViolations(container)).toEqual([]);
    await user.type(screen.getByLabelText(/^Title/), "Dentist");
    await user.click(within(screen.getByTestId("event-shares")).getByLabelText("Dufraing"));
    expect(screen.getByText("Only you are reminded, also when the event is shared.")).toBeVisible();
    await user.selectOptions(screen.getByTestId("event-reminder"), "15 minutes before");
    await user.click(screen.getByRole("button", { name: "Add event" }));
    await waitFor(() => {
      expect(sent("/api/v1/calendar/events", "POST")).toHaveLength(1);
    });
    const [body] = sent("/api/v1/calendar/events", "POST");
    expect(body).toMatchObject({
      homeId: null,
      event: {
        title: "Dentist",
        allDay: false,
        startsOn: "2026-11-10",
        endsOn: "2026-11-10",
        startTime: "09:00",
        endTime: "10:00",
        timezone: "Europe/Brussels",
        repeat: null,
        reminder: 15,
        shares: [HOME],
      },
    });
    expect(body?.event).not.toHaveProperty("participants");
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(`/calendar/events/${EVENT}`);
    });
  });

  it("says so when a time does not exist and offers the next one, in Dutch", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <EventForm
        homeId={HOME}
        defaultTimeZone="Europe/Brussels"
        timeZoneChoices={zones}
        members={members}
        homes={[]}
        dateFormat="dmy-slash"
        initialDate="2026-03-29"
      />,
      "nl",
    );
    const start = screen.getByLabelText(/^Begintijd/);
    await user.clear(start);
    await user.type(start, "02:30");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Deze tijd bestaat niet in Europe/Brussels",
    );
    await user.click(screen.getByRole("button", { name: "03:00 gebruiken" }));
    expect(start).toHaveValue("03:00");
  });

  it("refuses an end before the start without sending anything", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <EventForm
        homeId={HOME}
        defaultTimeZone="Europe/Brussels"
        timeZoneChoices={zones}
        members={members}
        homes={[]}
        dateFormat="dmy-slash"
        initialDate="2026-11-10"
      />,
    );
    await user.type(screen.getByLabelText(/^Title/), "Meeting");
    const end = screen.getByLabelText(/^End time/);
    await user.clear(end);
    await user.type(end, "08:00");
    await user.click(screen.getByRole("button", { name: "Add event" }));
    expect(await screen.findByText("The end must be after the start.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("changes this and following events only after showing which ones", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((_input, init) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as object) : {};
      return "dryRun" in body
        ? reply(200, {
            outcome: "preview",
            scope: "following",
            dates: ["2026-11-17", "2026-11-24"],
            more: true,
            removedChanges: 1,
          })
        : reply(200, { outcome: "saved", id: "0b0e0000-0000-4000-8000-0000000000ff", revision: 1 });
    });
    const { container } = renderWithQuery(
      <EventForm
        homeId={HOME}
        defaultTimeZone="Europe/Brussels"
        timeZoneChoices={zones}
        members={members}
        homes={[]}
        dateFormat="dmy-slash"
        initialDate="2026-11-10"
        event={eventDetail()}
        on="2026-11-17"
      />,
    );
    expect(screen.getByLabelText("This event")).toBeChecked();
    // The reminder belongs to the whole series, so one occurrence's change does not offer it.
    expect(screen.queryByTestId("event-reminder")).toBeNull();
    await user.click(screen.getByLabelText("This and following events"));
    expect(screen.getByTestId("event-reminder")).toHaveValue("");
    // What is left of a counted series from this occurrence on: 6 minus the one before.
    expect(screen.getByTestId("repeat-fields")).toBeInTheDocument();
    const title = screen.getByLabelText(/^Title/);
    await user.clear(title);
    await user.type(title, "Choir");
    await user.click(screen.getByRole("button", { name: "Review change" }));
    const preview = await screen.findByTestId("event-preview");
    expect(preview).toHaveTextContent("17/11/2026");
    expect(preview).toHaveTextContent("24/11/2026");
    expect(preview).toHaveTextContent("And later ones.");
    expect(preview).toHaveTextContent("1 event changed on its own no longer fits");
    expect(await axeViolations(container)).toEqual([]);
    expect(sent(`/calendar/events/${EVENT}`, "PATCH")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Save change" }));
    await waitFor(() => {
      expect(sent(`/calendar/events/${EVENT}`, "PATCH")).toHaveLength(2);
    });
    const saved = sent(`/calendar/events/${EVENT}`, "PATCH")[1];
    expect(saved).toMatchObject({
      revision: 3,
      scope: "following",
      on: "2026-11-17",
      event: {
        title: "Choir",
        startsOn: "2026-11-17",
        repeat: { frequency: "weekly", weekdays: [2], count: 5 },
      },
    });
    expect(saved).not.toHaveProperty("dryRun");
    expect(typeof saved?.newId).toBe("string");
  });

  it("changes one occurrence without its schedule or timezone", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() =>
      reply(200, { outcome: "preview", scope: "only", dates: ["2026-11-17"], more: false }),
    );
    renderWithQuery(
      <EventForm
        homeId={HOME}
        defaultTimeZone="Europe/Brussels"
        timeZoneChoices={zones}
        members={members}
        homes={[]}
        dateFormat="dmy-slash"
        initialDate="2026-11-10"
        event={eventDetail()}
        on="2026-11-17"
      />,
    );
    expect(screen.queryByTestId("repeat-fields")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Timezone")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Review change" }));
    await screen.findByTestId("event-preview");
    const [body] = sent(`/calendar/events/${EVENT}`, "PATCH");
    expect(body).toMatchObject({ scope: "only", on: "2026-11-17", dryRun: true });
    expect(body?.event).not.toHaveProperty("repeat");
  });
});

describe("deleting an event", () => {
  it("asks which events and lists them before deleting", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((_input, init) => {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as object) : {};
      return "dryRun" in body
        ? reply(200, { outcome: "preview", scope: "following", dates: ["2026-11-17"], more: false })
        : reply(200, { outcome: "deleted", revision: 4 });
    });
    const { container } = renderWithQuery(
      <EventActions
        homeId={HOME}
        eventHomeId={HOME}
        eventId={EVENT}
        revision={3}
        recurring
        on="2026-11-17"
        canEdit
        canDelete
        dateFormat="dmy-slash"
      />,
    );
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      `/homes/${HOME}/calendar/events/${EVENT}/edit?on=2026-11-17`,
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete event?" });
    await user.click(within(dialog).getByLabelText("This and following events"));
    await user.click(within(dialog).getByRole("button", { name: "Review" }));
    const preview = await within(dialog).findByTestId("event-delete-preview");
    expect(preview).toHaveTextContent("17/11/2026");
    expect(preview).toHaveTextContent("This cannot be undone from the trash.");
    expect(await axeViolations(container)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(`/homes/${HOME}/calendar`);
    });
    expect(sent(`/calendar/events/${EVENT}`, "DELETE")[1]).toEqual({
      revision: 3,
      scope: "following",
      on: "2026-11-17",
    });
  });

  it("offers nothing to someone who may only view, and only Edit without delete rights", () => {
    const first = renderWithQuery(
      <EventActions
        homeId={HOME}
        eventHomeId={HOME}
        eventId={EVENT}
        revision={3}
        recurring={false}
        on={null}
        canEdit={false}
        canDelete={false}
        dateFormat="dmy-slash"
      />,
    );
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
    first.unmount();
    renderWithQuery(
      <EventActions
        homeId={HOME}
        eventHomeId={null}
        eventId={EVENT}
        revision={3}
        recurring={false}
        on={null}
        canEdit
        canDelete={false}
        dateFormat="dmy-slash"
      />,
    );
    // The owner's personal event shown in a Home is edited in the personal space, with its shares.
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      `/calendar/events/${EVENT}/edit`,
    );
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });
});

describe("sharing, levels and vacations", () => {
  it("saves the Homes a personal event is shared with", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => reply(200, { outcome: "saved", revision: 4 }));
    const { container } = renderWithQuery(
      <ShareForm eventId={EVENT} revision={3} homes={homes} shared={[HOME]} />,
    );
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByLabelText("Dufraing"));
    await user.click(screen.getByLabelText("Studio"));
    await user.click(screen.getByRole("button", { name: "Save sharing" }));
    expect(await screen.findByText("Sharing saved.")).toBeInTheDocument();
    expect(sent(`/calendar/events/${EVENT}/shares`, "PUT")).toEqual([
      { revision: 3, homeIds: [OTHER_HOME] },
    ]);
  });

  it("sets a member's calendar level", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => reply(200, { outcome: "ok" }));
    const { container } = renderWithQuery(
      <CalendarAccessForm
        homeId={HOME}
        membershipId={OTHER_MEMBERSHIP}
        memberName="Sam"
        level="edit"
      />,
    );
    expect(await axeViolations(container)).toEqual([]);
    await user.selectOptions(screen.getByLabelText("Calendar access for Sam"), "edit_delete");
    await user.click(screen.getByRole("button", { name: "Save calendar access" }));
    expect(await screen.findByText("Calendar access for Sam saved.")).toBeInTheDocument();
    expect(sent(`/homes/${HOME}/calendar-access`, "PUT")).toEqual([
      { membershipId: OTHER_MEMBERSHIP, level: "edit_delete" },
    ]);
  });

  it("remembers each calendar's own overlays and vacation banners", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => reply(200, { outcome: "ok" }));
    const { unmount } = renderWithQuery(
      <CalendarToggles homeId={HOME} showTasks={false} showChores={false} showVacations />,
    );
    expect(screen.getByLabelText("Show Home vacations")).toBeChecked();
    expect(screen.getByLabelText("Show tasks")).not.toBeChecked();
    await user.click(screen.getByLabelText("Show Home vacations"));
    await user.click(screen.getByLabelText("Show chores"));
    await waitFor(() => {
      expect(sent("/calendar/preferences", "PUT")).toEqual([
        { homeId: HOME, showVacations: false },
        { homeId: HOME, showChores: true },
      ]);
    });
    expect(router.refresh).toHaveBeenCalled();
    expect(await axeViolations(document.body)).toEqual([]);
    unmount();
    // The Personal calendar has no chores or Home vacations to show.
    renderWithQuery(
      <CalendarToggles homeId={null} showTasks showChores={false} showVacations={false} />,
    );
    expect(screen.getByLabelText("Show tasks")).toBeChecked();
    expect(screen.queryByLabelText("Show chores")).toBeNull();
    expect(screen.queryByLabelText("Show Home vacations")).toBeNull();
  });
});
