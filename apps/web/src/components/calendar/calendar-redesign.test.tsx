// UX3b: the calendar's new-event dialog, the event preview and the work-period option. The
// database still decides every right (tests/db/rls/calendar.test.sql, work_periods.test.sql).
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { EVENT, HOME, eventDetail } from "@/calendar/testing";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { AddOnDayButton, CalendarClient, NewEventButton } from "./calendar-client";
import { EventForm } from "./event-form";
import { EventPreview, type EventPreviewProps } from "./event-preview";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), back: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/calendar" }));

const fetchMock = vi.fn<typeof fetch>();
const reply = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
const urlOf = (input: RequestInfo | URL | undefined): string =>
  input === undefined
    ? ""
    : typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
  router.push.mockClear();
});

const create = {
  defaultTimeZone: "Europe/Brussels",
  timeZoneChoices: ["Europe/Brussels", "UTC"],
  members: [],
  homes: [{ id: HOME, name: "Dufraing" }],
  googleTargets: null,
  today: "2026-11-10",
};

function calendar(canCreate = true) {
  return renderWithQuery(
    <CalendarClient
      homeId={null}
      dateFormat="dmy-slash"
      memberNames={{}}
      create={canCreate ? create : null}
    >
      <NewEventButton homeId={null} label="New event" />
      <AddOnDayButton homeId={null} date="2026-11-12" label="Add event on 12/11/2026" />
    </CalendarClient>,
  );
}

describe("the new-event dialog", () => {
  it("opens over the calendar, saves without leaving it, and closes", async () => {
    fetchMock.mockImplementation(() => reply(201, { outcome: "created", id: EVENT, revision: 1 }));
    const user = userEvent.setup();
    calendar();
    // Without JavaScript the button is the new-event page.
    expect(screen.getByTestId("calendar-new-event")).toHaveAttribute("href", "/calendar/new");
    await user.click(screen.getByTestId("calendar-new-event"));
    const dialog = await screen.findByRole("dialog", { name: "New event" });
    expect(within(dialog).getByTestId("event-starts-on")).toHaveValue("2026-11-10");
    await user.type(within(dialog).getByLabelText(/^Title/), "Dentist");
    await user.click(within(dialog).getByRole("button", { name: "Add event" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New event" })).not.toBeInTheDocument();
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("starts on the day whose + was used", async () => {
    const user = userEvent.setup();
    calendar();
    await user.click(screen.getByTestId("calendar-add-on-day"));
    const dialog = await screen.findByRole("dialog", { name: "New event" });
    expect(within(dialog).getByTestId("event-starts-on")).toHaveValue("2026-11-12");
  });

  it("asks before dropping what was typed, and keeps it on 'Keep editing'", async () => {
    const user = userEvent.setup();
    calendar();
    await user.click(screen.getByTestId("calendar-new-event"));
    const dialog = await screen.findByRole("dialog", { name: "New event" });
    await user.type(within(dialog).getByLabelText(/^Title/), "Dentist");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(within(dialog).getByLabelText(/^Title/)).toHaveValue("Dentist");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New event" })).not.toBeInTheDocument();
    });
  });

  it("is not offered where the person may not add events", () => {
    calendar(false);
    expect(screen.getByTestId("calendar-new-event")).toHaveAttribute("href", "/calendar/new");
    expect(screen.queryByRole("dialog", { name: "New event" })).not.toBeInTheDocument();
  });

  it("sends a work period as personal and unshared", async () => {
    fetchMock.mockImplementation(() => reply(201, { outcome: "created", id: EVENT, revision: 1 }));
    const user = userEvent.setup();
    calendar();
    await user.click(screen.getByTestId("calendar-new-event"));
    const dialog = await screen.findByRole("dialog", { name: "New event" });
    await user.type(within(dialog).getByLabelText(/^Title/), "Shift");
    await user.click(within(within(dialog).getByTestId("event-shares")).getByLabelText("Dufraing"));
    await user.click(within(dialog).getByTestId("event-work-period"));
    // Sharing is not offered for a work period.
    expect(within(dialog).queryByTestId("event-shares")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Add event" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      event: Record<string, unknown>;
    };
    expect(body.event).toMatchObject({ workPeriod: true, shares: [] });
  });
});

const preview: Omit<EventPreviewProps, "children"> = {
  href: `/calendar/events/${EVENT}?on=2026-11-17`,
  eventId: EVENT,
  on: "2026-11-17",
  source: "madeora",
  title: "Dentist",
  when: "09:00–10:00",
  dateLabel: "17/11/2026",
  location: "Main street 1",
  notes: ["Repeats"],
  workPeriod: false,
};

describe("the event preview", () => {
  const detail = (overrides = {}) =>
    fetchMock.mockImplementation((input) =>
      urlOf(input).includes(`/api/v1/calendar/events/${EVENT}`)
        ? reply(200, { event: eventDetail({ canEdit: true, ...overrides }) })
        : reply(404, { error: "not-found" }),
    );

  function open() {
    return renderWithQuery(
      <CalendarClient homeId={HOME} dateFormat="dmy-slash" memberNames={{}} create={null}>
        <EventPreview {...preview}>Dentist</EventPreview>
      </CalendarClient>,
    );
  }

  it("shows the time, place and notes, and reads the event for more", async () => {
    detail();
    const user = userEvent.setup();
    const { container } = open();
    const trigger = screen.getByRole("link", { name: "Dentist" });
    expect(trigger).toHaveAttribute("href", preview.href);
    await user.click(trigger);
    const panel = await screen.findByRole("dialog", { name: "Dentist" });
    expect(within(panel).getByText(/17\/11\/2026 · 09:00–10:00/)).toBeVisible();
    expect(within(panel).getByText(/Main street 1/)).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
    await user.click(within(panel).getByTestId("event-peek-more"));
    expect(await within(panel).findByTestId("event-more")).toBeVisible();
    // Edit appears only once the event says the person may edit it.
    expect(await within(panel).findByTestId("event-peek-edit")).toHaveAttribute(
      "href",
      expect.stringContaining(`/events/${EVENT}/edit`),
    );
    expect(within(panel).getByTestId("event-peek-open")).toHaveAttribute("href", preview.href);
  });

  it("offers no Edit on an event the person may not edit", async () => {
    detail({ canEdit: false });
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole("link", { name: "Dentist" }));
    const panel = await screen.findByRole("dialog", { name: "Dentist" });
    await user.click(within(panel).getByTestId("event-peek-more"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await within(panel).findByTestId("event-more");
    expect(within(panel).queryByTestId("event-peek-edit")).not.toBeInTheDocument();
  });

  it("closes with Escape and returns focus to the event", async () => {
    detail();
    const user = userEvent.setup();
    open();
    const trigger = screen.getByRole("link", { name: "Dentist" });
    await user.click(trigger);
    await screen.findByRole("dialog", { name: "Dentist" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Dentist" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("does not read a Google event, which has only its own page", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <CalendarClient homeId={null} dateFormat="dmy-slash" memberNames={{}} create={null}>
        <EventPreview {...preview} source="google">
          Dentist
        </EventPreview>
      </CalendarClient>,
    );
    await user.click(screen.getByRole("link", { name: "Dentist" }));
    const panel = await screen.findByRole("dialog", { name: "Dentist" });
    expect(within(panel).queryByTestId("event-peek-more")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("labels a work period in words", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <CalendarClient homeId={null} dateFormat="dmy-slash" memberNames={{}} create={null}>
        <EventPreview {...preview} source="google" workPeriod>
          Work
        </EventPreview>
      </CalendarClient>,
    );
    await user.click(screen.getByRole("link", { name: "Work" }));
    const panel = await screen.findByRole("dialog", { name: "Dentist" });
    expect(within(panel).getByText("Work", { selector: "p" })).toBeVisible();
  });
});

describe("a work series", () => {
  const work = eventDetail({
    homeId: null,
    kind: "personal",
    shares: [],
    series: { ...eventDetail().series, workPeriod: true },
  });

  async function save(scope: "all" | "following") {
    fetchMock.mockImplementation(() => reply(200, { outcome: "updated", id: EVENT, revision: 4 }));
    const user = userEvent.setup();
    renderWithQuery(
      <EventForm
        homeId={null}
        defaultTimeZone="Europe/Brussels"
        timeZoneChoices={["Europe/Brussels"]}
        members={[]}
        homes={[]}
        dateFormat="dmy-slash"
        initialDate="2026-11-10"
        event={work}
        on="2026-11-17"
      />,
    );
    await user.click(screen.getByTestId(`event-scope-${scope}`));
    await user.click(screen.getByRole("button", { name: "Review change" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const init = fetchMock.mock.calls[0]?.[1];
    return JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      event: Record<string, unknown>;
    };
  }

  it("keeps its flag when 'this and following' starts a later series", async () => {
    expect((await save("following")).event).toMatchObject({ workPeriod: true });
  });

  it("sends no flag when the whole series changes (it is fixed at creation)", async () => {
    expect((await save("all")).event).not.toHaveProperty("workPeriod");
  });

  it("offers no work-period box when editing", () => {
    renderWithQuery(
      <EventForm
        homeId={null}
        defaultTimeZone="Europe/Brussels"
        timeZoneChoices={["Europe/Brussels"]}
        members={[]}
        homes={[]}
        dateFormat="dmy-slash"
        initialDate="2026-11-10"
        event={work}
      />,
    );
    expect(screen.queryByTestId("event-work-period")).not.toBeInTheDocument();
  });
});

describe("the preview on a narrow screen", () => {
  it("is a bottom sheet with a close button", async () => {
    const spy = vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: true,
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    try {
      const user = userEvent.setup();
      renderWithQuery(
        <CalendarClient homeId={null} dateFormat="dmy-slash" memberNames={{}} create={null}>
          <EventPreview {...preview} source="google">
            Dentist
          </EventPreview>
        </CalendarClient>,
      );
      await user.click(screen.getByRole("link", { name: "Dentist" }));
      const sheet = await screen.findByRole("dialog", { name: "Dentist" });
      expect(within(sheet).getByText(/17\/11\/2026 · 09:00–10:00/)).toBeVisible();
      await user.click(within(sheet).getByRole("button", { name: "Close" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Dentist" })).not.toBeInTheDocument();
      });
    } finally {
      spy.mockRestore();
    }
  });
});
