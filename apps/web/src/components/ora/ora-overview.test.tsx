import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";

import en from "@/i18n/messages/en.json";
import type { Overview, OverviewItem } from "@/ora/overview/types";
import { axeViolations } from "@/test/axe";

import { OraOverview } from "./ora-overview";

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const SAM = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a2";

interface TestState {
  calls: { tool: string; homeId: unknown; input: unknown }[];
  overview: unknown;
  status: number;
  share: unknown;
  shareStatus: number;
}
const state = vi.hoisted((): TestState => ({
  calls: [],
  overview: null,
  status: 200,
  share: null,
  shareStatus: 200,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

function item(overrides: Partial<OverviewItem> = {}): OverviewItem {
  return {
    key: "calendar:a::2026-11-16",
    module: "calendar",
    title: "Dentist",
    day: "2026-11-16",
    allDay: false,
    startsAt: "2026-11-16T09:00:00.000Z",
    endsAt: "2026-11-16T10:00:00.000Z",
    timeZone: "UTC",
    status: "open",
    href: `/homes/${HOME_ID}/calendar/events/a`,
    origin: "own",
    assigneeIds: [],
    canComplete: false,
    ...overrides,
  };
}

function overview(overrides: Partial<Overview> = {}): Overview {
  const timed = [item()];
  const untimed = [
    item({
      key: "tasks:t:2026-11-16",
      module: "tasks",
      title: "Pay rent",
      allDay: false,
      startsAt: null,
      endsAt: null,
      href: `/homes/${HOME_ID}/tasks/t`,
      canComplete: true,
    }),
  ];
  return {
    homeId: HOME_ID,
    scope: "day",
    from: "2026-11-16",
    to: "2026-11-16",
    today: "2026-11-16",
    timeZone: "UTC",
    filters: { modules: [], assignee: "anyone", completion: "all" },
    members: [
      { id: "me", name: "Alex", isSelf: true, shareable: false },
      { id: SAM, name: "Sam", isSelf: false, shareable: true },
    ],
    modules: ["calendar", "tasks", "chores"],
    days: [
      {
        date: "2026-11-16",
        timed,
        untimed,
        counts: { calendar: 1, tasks: 1, chores: 0 },
        busier: false,
      },
    ],
    notices: [],
    incomplete: false,
    empty: null,
    truncated: false,
    ...overrides,
  };
}

beforeEach(() => {
  state.calls = [];
  state.overview = overview();
  state.status = 200;
  state.share = null;
  state.shareStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as {
        tool: string;
        homeId: unknown;
        input: unknown;
      };
      state.calls.push(body);
      if (body.tool === "share-overview") {
        return Promise.resolve(
          Response.json(
            { output: { kind: "share", share: state.share } },
            { status: state.shareStatus },
          ),
        );
      }
      return Promise.resolve(
        Response.json(
          { output: { kind: "overview", overview: state.overview } },
          { status: state.status },
        ),
      );
    }),
  );
});

function setup(props: Partial<React.ComponentProps<typeof OraOverview>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onNavigated = vi.fn();
  const view = render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <QueryClientProvider client={client}>
        <OraOverview
          userId="user-a"
          homeId={HOME_ID}
          contextName="Thuis"
          initialTarget="today"
          onBack={vi.fn()}
          onNavigated={onNavigated}
          onStatus={vi.fn()}
          {...props}
        />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { ...view, onNavigated };
}

describe("Ora overview", () => {
  it("asks the server for the chosen period and shows the date range and context", async () => {
    setup();
    expect(await screen.findByTestId("ora-overview-range")).toHaveTextContent(
      "Monday, November 16, 2026 · Thuis",
    );
    expect(state.calls[0]).toMatchObject({
      tool: "overview",
      homeId: HOME_ID,
      input: { target: "today", filters: { modules: [], assignee: "anyone", completion: "all" } },
    });
    expect(screen.getByText(/1 event · 1 task|1 event, 1 task/)).toBeInTheDocument();
  });

  it("keeps related items collapsed until asked, then lists them in order with links", async () => {
    const user = userEvent.setup();
    const { onNavigated } = setup();
    await screen.findByTestId("ora-overview-body");
    expect(screen.queryByText("Pay rent")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View related items" }));
    const items = screen.getByRole("region", { name: /Monday/ });
    const links = within(items).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Dentist",
      "Pay rent",
      "Open to complete",
    ]);
    expect(links[0]).toHaveAttribute("href", `/homes/${HOME_ID}/calendar/events/a`);
    expect(screen.getByText("No set time")).toBeInTheDocument();
    await user.click(links[1] as HTMLElement);
    expect(onNavigated).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Hide related items" }));
    expect(screen.queryByText("Pay rent")).not.toBeInTheDocument();
  });

  it("never links outside Madeora", async () => {
    state.overview = overview({
      days: [
        {
          date: "2026-11-16",
          timed: [],
          untimed: [
            item({ module: "tasks", startsAt: null, title: "Evil", href: "https://evil.example" }),
          ],
          counts: { calendar: 0, tasks: 1, chores: 0 },
          busier: false,
        },
      ],
    });
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole("button", { name: "View related items" }));
    expect(screen.queryByRole("link", { name: "Evil" })).not.toBeInTheDocument();
    expect(screen.getByText("Evil")).toBeInTheDocument();
  });

  it("asks again with the filter when one is chosen and clears it", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByTestId("ora-overview-body");
    await user.click(screen.getByRole("button", { name: "Assigned to me" }));
    await waitFor(() => {
      expect(state.calls.at(-1)?.input).toMatchObject({ filters: { assignee: "me" } });
    });
    expect(await screen.findByText(/not the whole schedule/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => {
      expect(state.calls.at(-1)?.input).toMatchObject({ filters: { assignee: "anyone" } });
    });
    expect(screen.queryByText(/not the whole schedule/)).not.toBeInTheDocument();
  });

  it("switches period with the presets and a picked date", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByTestId("ora-overview-body");
    await user.click(screen.getByRole("button", { name: "This week" }));
    await waitFor(() => {
      expect(state.calls.at(-1)?.input).toMatchObject({ target: "this-week" });
    });
    expect(screen.getByRole("button", { name: "That day" })).toBeDisabled();
    await user.type(screen.getByLabelText("Pick a date"), "2026-12-01");
    await user.click(screen.getByRole("button", { name: "That week" }));
    await waitFor(() => {
      expect(state.calls.at(-1)?.input).toMatchObject({ target: "week", date: "2026-12-01" });
    });
  });

  it("says plainly that an overview is incomplete and never calls an empty one free", async () => {
    state.overview = overview({
      days: [
        {
          date: "2026-11-16",
          timed: [],
          untimed: [],
          counts: { calendar: 0, tasks: 0, chores: 0 },
          busier: false,
        },
      ],
      notices: [
        { kind: "stale", module: "calendar", source: "Work", lastSyncedAt: "2026-11-15T08:00:00Z" },
        { kind: "unavailable", module: "tasks", source: null, lastSyncedAt: null },
      ],
      incomplete: true,
      empty: "incomplete",
    });
    setup();
    const notices = await screen.findByTestId("ora-overview-notices");
    expect(notices).toHaveTextContent("This overview may be incomplete");
    expect(notices).toHaveTextContent("Work is out of date. Last updated");
    expect(notices).toHaveTextContent("Tasks could not be read just now.");
    expect(screen.getByTestId("ora-overview-empty")).toHaveTextContent(
      "does not mean the period is free",
    );
  });

  it("offers at most two permitted shortcuts in an empty state and none for filters", async () => {
    state.overview = overview({
      days: [
        {
          date: "2026-11-16",
          timed: [],
          untimed: [],
          counts: { calendar: 0, tasks: 0, chores: 0 },
          busier: false,
        },
      ],
      modules: ["calendar"],
      empty: "none",
    });
    setup();
    const empty = await screen.findByTestId("ora-overview-empty");
    expect(within(empty).getAllByRole("link")).toHaveLength(1);
    expect(within(empty).getByRole("link", { name: "Open the calendar" })).toHaveAttribute(
      "href",
      `/homes/${HOME_ID}/calendar`,
    );
  });

  it("notes busier days without judging the person", async () => {
    const [day] = overview().days;
    if (!day) throw new Error("fixture");
    state.overview = overview({
      scope: "week",
      to: "2026-11-22",
      days: [
        { ...day, date: "2026-11-18", busier: true },
        { ...day, date: "2026-11-19", busier: false },
      ],
    });
    setup();
    expect(await screen.findByTestId("ora-overview-busier")).toHaveTextContent(
      "Wednesday looks busier, with several scheduled items.",
    );
  });

  it("shows a calm failure with a retry, and a message when access was lost", async () => {
    state.status = 503;
    const user = userEvent.setup();
    setup();
    expect(await screen.findByTestId("ora-overview-failed")).toHaveTextContent(
      "could not prepare the overview",
    );
    state.status = 200;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByTestId("ora-overview-body")).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = setup();
    await screen.findByTestId("ora-overview-body");
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("Ora overview: sharing a copy", () => {
  it("is not offered in the Personal space or when nobody can be chosen", async () => {
    setup({ homeId: null });
    await screen.findByTestId("ora-overview-body");
    expect(screen.queryByRole("button", { name: "Share a copy" })).not.toBeInTheDocument();
  });

  it("prepares an editable text for the chosen member, warns, and copies only on request", async () => {
    state.share = {
      audience: { id: SAM, name: "Sam" },
      text: "Overview\n- Dentist",
      incomplete: false,
    };
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setup();
    await screen.findByTestId("ora-overview-body");
    await user.click(screen.getByRole("button", { name: "Share a copy" }));
    // Only members that can be an audience are offered; the requester and children are not.
    const select = screen.getByLabelText("Who is it for?");
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Choose a member", "Sam"]);
    expect(screen.getByRole("button", { name: "Prepare text" })).toBeDisabled();
    await user.selectOptions(select, SAM);
    await user.click(screen.getByRole("button", { name: "Prepare text" }));
    const textbox = await screen.findByLabelText("Text to copy (you can edit it)");
    expect(textbox).toHaveValue("Overview\n- Dentist");
    expect(screen.getByText(/cannot limit who sees it or take it back/)).toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();
    expect(state.calls.at(-1)).toMatchObject({
      tool: "share-overview",
      input: { audience: SAM, request: { target: "today" } },
    });
    await user.type(textbox, " edited");
    await user.click(screen.getByRole("button", { name: "Copy text" }));
    expect(writeText).toHaveBeenCalledWith("Overview\n- Dentist edited");
    expect(await screen.findByText("Copied.")).toBeInTheDocument();
  });

  it("throws the prepared text away when the period or filters change", async () => {
    state.share = { audience: { id: SAM, name: "Sam" }, text: "Text", incomplete: false };
    const user = userEvent.setup();
    setup();
    await screen.findByTestId("ora-overview-body");
    await user.click(screen.getByRole("button", { name: "Share a copy" }));
    await user.selectOptions(screen.getByLabelText("Who is it for?"), SAM);
    await user.click(screen.getByRole("button", { name: "Prepare text" }));
    await screen.findByLabelText("Text to copy (you can edit it)");
    await user.click(screen.getByRole("button", { name: "Tomorrow" }));
    await waitFor(() => {
      expect(screen.queryByLabelText("Text to copy (you can edit it)")).not.toBeInTheDocument();
    });
  });

  it("says so when no text can be prepared for that person", async () => {
    state.shareStatus = 403;
    const user = userEvent.setup();
    setup();
    await screen.findByTestId("ora-overview-body");
    await user.click(screen.getByRole("button", { name: "Share a copy" }));
    await user.selectOptions(screen.getByLabelText("Who is it for?"), SAM);
    await user.click(screen.getByRole("button", { name: "Prepare text" }));
    expect(
      await screen.findByText("A text cannot be prepared for that person."),
    ).toBeInTheDocument();
  });
});
