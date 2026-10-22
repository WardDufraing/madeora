// S21: the pool, claiming with Undo, the claim panel, handover requests, the claim policy editor and
// the live refresh. The database decides who wins a claim and every rule (tests/db/rls/
// chore-pool.test.sql); these tests check what the interface sends, shows and announces.
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";

import { ToastProvider } from "@/components/ui/toast";
import type {
  ChoreClaimPolicy,
  ChoreClaimState,
  ChorePool as ChorePoolData,
  ChorePoolRow,
} from "@/chores/api";
import { defaultPoolFilter, filterPool } from "@/chores/pool";
import type { DateTimeFormats } from "@/invitations/format";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { ChoreClaim } from "./chore-claim";
import { ChoreClaimPolicyEditor } from "./chore-claim-policy";
import { ChorePool } from "./chore-pool";
import { ChorePoolLive } from "./chore-pool-live";
import { ChoreRequests } from "./chore-requests";
import { ChoreSettingsForm } from "./chore-settings-form";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

interface FakeChannel {
  handler: ((payload: { new: Record<string, unknown> }) => void) | null;
  status: ((status: string) => void) | null;
}
interface FakeRealtime {
  channel: FakeChannel;
  version: number;
  removed: number;
  filters: unknown[];
}
const realtime = vi.hoisted((): FakeRealtime => ({
  channel: { handler: null, status: null },
  version: 0,
  removed: 0,
  filters: [],
}));
vi.mock("@/auth/supabase-browser", () => ({
  getSupabaseBrowserClient: () => ({
    channel: () => {
      const channel = {
        on: (_type: string, filter: unknown, handler: FakeChannel["handler"]) => {
          realtime.filters.push(filter);
          realtime.channel.handler = handler;
          return channel;
        },
        subscribe: (status: FakeChannel["status"]) => {
          realtime.channel.status = status;
          return channel;
        },
      };
      return channel;
    },
    removeChannel: () => {
      realtime.removed += 1;
      return Promise.resolve("ok");
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { version: realtime.version }, error: null }),
        }),
      }),
    }),
  }),
}));

const HOME = "0b6f6c55-3a4e-4f7a-9f15-9a8a1d0c0001";
const CHORE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0015";
const OCCURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const OTHER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021";
const THIRD = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0022";
const REQUEST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0060";
const ME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0041";
const BEA = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0042";
const CAL = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0043";
const CATEGORY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0050";

const formats: DateTimeFormats = {
  timeZone: "Europe/Brussels",
  dateFormat: "ymd-dash",
  timeFormat: "24h",
  locale: "en",
};
const members = [
  { id: ME, name: "Ann", isSelf: true },
  { id: BEA, name: "Bea", isSelf: false },
  { id: CAL, name: "Cal", isSelf: false },
];

const fetchMock = vi.fn<typeof fetch>();
const bodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  realtime.channel = { handler: null, status: null };
  realtime.version = 0;
  realtime.removed = 0;
  realtime.filters = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  router.refresh.mockClear();
});

function withToasts(ui: ReactElement) {
  return renderWithQuery(
    <ToastProvider regionLabel="Notifications" dismissLabel="Dismiss">
      {ui}
    </ToastProvider>,
  );
}

function row(extra: Partial<ChorePoolRow> = {}): ChorePoolRow {
  return {
    id: OCCURRENCE,
    choreId: CHORE,
    title: "Water the plants",
    kind: "recurring",
    category: { id: CATEGORY, name: "Garden", color: null },
    scheduledDate: "2026-10-22",
    dueDate: "2026-10-22",
    section: "week",
    overdue: false,
    minutes: 10,
    stepsTotal: 0,
    requiresApproval: false,
    restricted: false,
    eligible: true,
    closesOn: null,
    revision: 1,
    ...extra,
  };
}

const rows = [
  row(),
  row({
    id: OTHER,
    title: "Clean the shed",
    category: null,
    minutes: null,
    dueDate: "2026-10-24",
    restricted: true,
    eligible: false,
  }),
  row({
    id: THIRD,
    title: "Sweep the path",
    dueDate: "2026-10-12",
    section: "overdue",
    overdue: true,
    minutes: 90,
    closesOn: null,
  }),
];

function pool(list: readonly ChorePoolRow[] = rows): ChorePoolData {
  return { rows: list, weekStart: "2026-10-19", today: "2026-10-21", truncated: false };
}

function showPool(list: readonly ChorePoolRow[] = rows) {
  return withToasts(
    <ChorePool
      homeId={HOME}
      pool={pool(list)}
      week={{
        start: "2026-10-19",
        current: true,
        previousHref: "/homes/h/chores?poolWeek=2026-10-12",
        nextHref: "/homes/h/chores?poolWeek=2026-10-26",
        currentHref: "/homes/h/chores",
      }}
      today="2026-10-21"
      categories={[{ id: CATEGORY, name: "Garden" }]}
      formats={formats}
    />,
  );
}

describe("filterPool", () => {
  const collator = new Intl.Collator("en");

  it("keeps due-date order with a title tie-breaker, either direction", () => {
    const tied = [row({ id: OTHER, title: "B" }), row({ id: THIRD, title: "a" })];
    expect(filterPool(tied, defaultPoolFilter, collator).map((r) => r.title)).toEqual(["a", "B"]);
    expect(
      filterPool(rows, { ...defaultPoolFilter, sort: "desc" }, collator).map((r) => r.dueDate),
    ).toEqual(["2026-10-24", "2026-10-22", "2026-10-12"]);
  });

  it("filters by Uncategorized, unset duration, a duration bound, dates and claimability", () => {
    const ids = (filter: Partial<typeof defaultPoolFilter>) =>
      filterPool(rows, { ...defaultPoolFilter, ...filter }, collator).map((r) => r.id);
    expect(ids({ category: "none" })).toEqual([OTHER]);
    expect(ids({ category: CATEGORY })).toEqual([THIRD, OCCURRENCE]);
    expect(ids({ duration: "none" })).toEqual([OTHER]);
    expect(ids({ duration: "15" })).toEqual([OCCURRENCE]);
    expect(ids({ duration: "more" })).toEqual([THIRD]);
    expect(ids({ from: "2026-10-20", to: "2026-10-23" })).toEqual([OCCURRENCE]);
    expect(ids({ onlyClaimable: true })).toEqual([THIRD, OCCURRENCE]);
  });
});

describe("the pool", () => {
  it("shows this week and the overdue ones, Claim or Not eligible, without saying who may", async () => {
    const { container } = showPool();
    const pool = screen.getByTestId("chore-pool");
    expect(within(pool).getByRole("heading", { name: /Unassigned chores/ })).toBeInTheDocument();
    const week = screen.getByTestId("pool-week");
    expect(within(week).getAllByTestId("pool-row")).toHaveLength(2);
    expect(within(screen.getByTestId("pool-overdue")).getByText("Sweep the path")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /^Claim / })).toHaveLength(2);
    expect(screen.getByTestId("pool-not-eligible")).toHaveTextContent("Not eligible to claim");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("filters with matching and total counts, tells no match from empty, and resets", async () => {
    const user = userEvent.setup();
    showPool();
    await user.click(screen.getByText("Filter and sort"));
    await user.click(screen.getByLabelText("Show only what I can claim"));
    expect(screen.getByTestId("chore-pool-count")).toHaveTextContent("2 of 3");
    await user.selectOptions(screen.getByLabelText("Category"), "Uncategorized");
    expect(screen.getByText("No unassigned chores match these filters.")).toBeVisible();
    await user.click(screen.getByTestId("pool-reset"));
    expect(screen.getAllByTestId("pool-row")).toHaveLength(3);
  });

  it("says when nothing waits to be claimed", () => {
    showPool([]);
    expect(screen.getByText("Nothing is waiting to be claimed.")).toBeVisible();
  });

  it("claims in one tap and offers Undo, which releases the same claim", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(Response.json({ outcome: "claimed", revision: 2 }))
      .mockResolvedValueOnce(Response.json({ outcome: "released", status: "open", revision: 3 }));
    showPool([row()]);
    await user.click(screen.getByRole("button", { name: "Claim Water the plants" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/chore-occurrences/${OCCURRENCE}/claim`);
    expect(await screen.findAllByText("You claimed Water the plants.")).not.toHaveLength(0);
    expect(router.refresh).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/chore-occurrences/${OCCURRENCE}/release`);
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toEqual({ undo: true });
    expect(
      await screen.findAllByText("Claim undone: Water the plants is back in the pool."),
    ).not.toHaveLength(0);
  });

  it("explains a lost race and reads the list again", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { error: "already-claimed", claimedByMe: false, claimant: BEA },
        { status: 409 },
      ),
    );
    showPool([row()]);
    await user.click(screen.getByRole("button", { name: "Claim Water the plants" }));
    expect(
      await screen.findAllByText("Someone else claimed this chore just before you."),
    ).not.toHaveLength(0);
    expect(router.refresh).toHaveBeenCalled();
  });
});

function claimState(extra: Partial<ChoreClaimState> = {}): ChoreClaimState {
  return {
    claimMode: "all",
    expiryPolicy: "week_end",
    autoReleaseHours: 24,
    claimable: false,
    block: "already_claimed",
    claimedBy: { me: true, member: ME },
    claimedAt: "2026-10-21T08:00:00Z",
    canRelease: true,
    releaseAt: "2026-10-23T22:00:00Z",
    closesOn: "2026-10-26",
    expiredAt: null,
    canRequest: true,
    canRequestForOthers: false,
    confirmationRequired: false,
    requests: [],
    ...extra,
  };
}

function showClaim(state: ChoreClaimState, stepsChecked = 0) {
  return withToasts(
    <ChoreClaim
      occurrenceId={OCCURRENCE}
      title="Water the plants"
      state={state}
      members={members}
      assigneeIds={[ME]}
      stepsChecked={stepsChecked}
      formats={formats}
    />,
  );
}

describe("an occurrence's claim", () => {
  it("summarizes the policies and who has it", async () => {
    const { container } = showClaim(claimState());
    expect(screen.getByText("All members")).toBeVisible();
    expect(screen.getByText("Closes at the end of its week")).toBeVisible();
    expect(screen.getByText("Can be claimed until 2026-10-25")).toBeVisible();
    expect(screen.getByText("24 hours after the due day")).toBeVisible();
    expect(screen.getByTestId("chore-claim-status")).toHaveTextContent(
      "Claimed by you on 2026-10-21 10:00. Released automatically on 2026-10-24 00:00 if it is not done.",
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it("warns that releasing clears ticked steps, then releases", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      Response.json({ outcome: "released", status: "open", revision: 3 }),
    );
    showClaim(claimState(), 2);
    await user.click(screen.getByTestId("chore-release-open"));
    const dialog = await screen.findByRole("dialog", { name: "Release this chore?" });
    expect(dialog).toHaveTextContent("the 2 ticked steps are cleared");
    await user.click(within(dialog).getByTestId("chore-release-confirm"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ undo: false });
  });

  it("says Not eligible for a restricted chore and offers Claim where it may", () => {
    showClaim(
      claimState({
        claimMode: "selected",
        block: "not_eligible",
        claimedBy: null,
        claimedAt: null,
        canRelease: false,
        releaseAt: null,
        canRequest: false,
      }),
    );
    expect(screen.getByTestId("chore-claim-status")).toHaveTextContent("Not eligible to claim");
    expect(screen.queryByRole("button", { name: /^Claim / })).toBeNull();
  });

  it("asks a member who is not on it to take over, with a normalized note and one id per request", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      Response.json({ outcome: "requested", status: "pending" }, { status: 201 }),
    );
    showClaim(claimState());
    await user.click(screen.getByTestId("chore-request-open"));
    const form = screen.getByTestId("chore-request-form");
    const select = within(form).getByLabelText(/^Ask/);
    // Neither the viewer nor someone already on it can be asked.
    expect(within(select).queryByRole("option", { name: "You" })).toBeNull();
    await user.click(within(form).getByTestId("chore-request-send"));
    expect(within(form).getByText("Choose who to ask.")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.selectOptions(select, "Bea");
    await user.type(within(form).getByLabelText("Note (optional)"), "  Away   tonight ");
    await user.click(within(form).getByTestId("chore-request-send"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const body = bodyOf(fetchMock.mock.calls[0]?.[1]) as Record<string, unknown>;
    expect(body).toMatchObject({ toMember: BEA, note: "Away tonight" });
    expect(typeof body.id).toBe("string");
  });

  it("lets a chore manager who is not on it hand it over from an assignee", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      Response.json({ outcome: "requested", status: "pending" }, { status: 201 }),
    );
    withToasts(
      <ChoreClaim
        occurrenceId={OCCURRENCE}
        title="Water the plants"
        state={claimState({ canRequest: true, canRequestForOthers: true, claimedBy: null })}
        members={members.map((member) => ({ ...member, isSelf: member.id === CAL }))}
        assigneeIds={[ME]}
        stepsChecked={0}
        formats={formats}
      />,
    );
    await user.click(screen.getByTestId("chore-request-open"));
    const form = screen.getByTestId("chore-request-form");
    const from = within(form).getByLabelText("Hand over from");
    await user.selectOptions(within(form).getByLabelText(/^Ask/), "Bea");
    await user.click(within(form).getByTestId("chore-request-send"));
    expect(fetchMock).not.toHaveBeenCalled();
    await user.selectOptions(from, "Ann");
    await user.click(within(form).getByTestId("chore-request-send"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({ toMember: BEA, fromMember: ME });
  });

  it("shows a request's state and the answers the viewer may give", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(Response.json({ outcome: "accepted", status: "accepted" }));
    showClaim(
      claimState({
        claimedBy: null,
        canRelease: false,
        canRequest: false,
        requests: [
          {
            id: REQUEST,
            status: "pending",
            from: { me: false, member: BEA },
            to: { me: true, member: ME },
            by: { me: false, member: BEA },
            note: "Away tonight",
            createdAt: "2026-10-21T08:00:00Z",
            respondedAt: null,
            decidedAt: null,
            decidedBy: null,
            invalidReason: null,
            canAnswer: true,
            canCancel: false,
            canConfirm: false,
          },
        ],
      }),
    );
    expect(screen.getByTestId("chore-request-status")).toHaveTextContent("Waiting for an answer.");
    await user.click(screen.getByRole("button", { name: "Accept taking over Water the plants" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/chore-reassignment-requests/${REQUEST}`);
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ action: "accept" });
  });
});

describe("the requests list", () => {
  it("groups what is asked of the viewer and what they asked, with the right answers", async () => {
    const { container } = withToasts(
      <ChoreRequests
        homeId={HOME}
        members={members}
        formats={formats}
        requests={[
          {
            id: REQUEST,
            occurrenceId: OCCURRENCE,
            title: "Water the plants",
            dueDate: "2026-10-22",
            status: "pending",
            box: "incoming",
            from: { me: false, member: BEA },
            to: { me: true, member: ME },
            note: null,
            createdAt: "2026-10-21T08:00:00Z",
          },
          {
            id: OTHER,
            occurrenceId: OTHER,
            title: "Clean the shed",
            dueDate: "2026-10-24",
            status: "awaiting_manager",
            box: "outgoing",
            from: { me: true, member: ME },
            to: { me: false, member: CAL },
            note: null,
            createdAt: "2026-10-21T08:00:00Z",
          },
        ]}
      />,
    );
    const [incoming, outgoing] = screen.getAllByTestId("chore-request");
    expect(within(incoming as HTMLElement).getByTestId("chore-request-accept")).toBeVisible();
    expect(within(incoming as HTMLElement).getByTestId("chore-request-decline")).toBeVisible();
    expect(outgoing).toHaveTextContent("From you to Cal");
    expect(outgoing).toHaveTextContent("waiting for a chore manager");
    expect(within(outgoing as HTMLElement).getByTestId("chore-request-cancel")).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
  });
});

const storedPolicy: ChoreClaimPolicy = {
  claimMode: "all",
  members: [],
  expiryPolicy: "overdue",
  autoReleaseHours: null,
  revision: 4,
};

describe("the claim policy editor", () => {
  it("saves a change without effects at once after its preview", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          outcome: "preview",
          impact: { expireNow: 0, releaseNow: 0, claimedIneligible: 0 },
          revision: 4,
        }),
      )
      .mockResolvedValueOnce(Response.json({ outcome: "saved", impact: null, revision: 5 }));
    withToasts(<ChoreClaimPolicyEditor choreId={CHORE} policy={storedPolicy} members={members} />);
    await user.click(screen.getByTestId("chore-policy-edit"));
    await user.click(screen.getByLabelText("Selected members"));
    await user.click(screen.getByTestId("chore-policy-save"));
    expect(screen.getByText("Choose at least one member.")).toBeVisible();
    await user.click(screen.getByLabelText("Bea"));
    await user.click(screen.getByLabelText("Release claims automatically"));
    await user.clear(screen.getByLabelText("Hours after the due day (0 to 720)"));
    await user.type(screen.getByLabelText("Hours after the due day (0 to 720)"), "48");
    await user.click(screen.getByTestId("chore-policy-save"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      expectedRevision: 4,
      mode: "selected",
      memberIds: [BEA],
      expiry: "overdue",
      autoReleaseHours: 48,
      dryRun: true,
      confirm: false,
    });
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toMatchObject({ dryRun: false, confirm: true });
  });

  it("shows what a change would close or release at once and waits for confirmation", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      Response.json({
        outcome: "preview",
        impact: { expireNow: 2, releaseNow: 0, claimedIneligible: 1 },
        revision: 4,
      }),
    );
    withToasts(<ChoreClaimPolicyEditor choreId={CHORE} policy={storedPolicy} members={members} />);
    await user.click(screen.getByTestId("chore-policy-edit"));
    await user.selectOptions(
      screen.getByLabelText("After its week"),
      "Closes at the end of its week",
    );
    await user.click(screen.getByTestId("chore-policy-save"));
    const impact = await screen.findByTestId("chore-policy-impact");
    expect(impact).toHaveTextContent("2 unclaimed occurrences whose week has ended close now.");
    expect(impact).toHaveTextContent("1 existing claim stays");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("chore-policy-confirm")).toBeVisible();
  });
});

describe("live updates", () => {
  it("subscribes to its Home's signal only and refreshes when the version moves past the page", async () => {
    vi.useFakeTimers();
    realtime.version = 3;
    const { unmount } = renderWithQuery(<ChorePoolLive homeId={HOME} version={3} />);
    expect(realtime.filters).toEqual([
      { event: "*", schema: "public", table: "chore_pool_signals", filter: `home_id=eq.${HOME}` },
    ]);
    // Connected with nothing missed: no refresh.
    await act(async () => {
      realtime.channel.status?.("SUBSCRIBED");
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(router.refresh).not.toHaveBeenCalled();
    // A change by someone else: one refresh, however many events arrive together.
    act(() => {
      realtime.channel.handler?.({ new: { version: 4 } });
      realtime.channel.handler?.({ new: { version: 5 } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // An event the page already shows changes nothing.
    act(() => {
      realtime.channel.handler?.({ new: { version: 5 } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(router.refresh).toHaveBeenCalledTimes(1);
    unmount();
    expect(realtime.removed).toBe(1);
  });

  it("catches a change missed before subscribing", async () => {
    vi.useFakeTimers();
    realtime.version = 7;
    renderWithQuery(<ChorePoolLive homeId={HOME} version={6} />);
    await act(async () => {
      realtime.channel.status?.("SUBSCRIBED");
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("catches a change whose event never arrived, by reading the version every few seconds", async () => {
    vi.useFakeTimers();
    realtime.version = 3;
    renderWithQuery(<ChorePoolLive homeId={HOME} version={3} />);
    await act(async () => {
      realtime.channel.status?.("SUBSCRIBED");
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(router.refresh).not.toHaveBeenCalled();
    realtime.version = 4;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("the Home's chore settings", () => {
  it("saves the week start and the confirmation rule against the stored revision", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(Response.json({ outcome: "saved", revision: 1 }));
    const { container } = withToasts(
      <ChoreSettingsForm
        homeId={HOME}
        settings={{
          weekStart: "monday",
          reassignmentConfirmation: false,
          revision: 0,
          canManage: true,
        }}
      />,
    );
    await user.selectOptions(screen.getByLabelText(/Chore weeks start on/), "Sunday");
    await user.click(screen.getByLabelText("Handovers need a chore manager's confirmation"));
    await user.click(screen.getByTestId("chore-settings-save"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/chore-settings");
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      homeId: HOME,
      expectedRevision: 0,
      weekStart: "sunday",
      reassignmentConfirmation: true,
    });
    expect(await axeViolations(container)).toEqual([]);
  });
});
