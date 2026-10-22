// S22: recording a vacation, answering an invitation and deciding an affected chore. The database
// decides every right, date and rotation (tests/db/rls/home-vacations.test.sql); these tests check
// what the interface sends, shows and confirms.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { DateTimeFormats } from "@/invitations/format";
import { memberNames } from "@/tasks/format";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";
import type { ReviewItem, VacationImpact } from "@/vacations/api";

import { InvitationActions } from "./invitation-actions";
import { NewVacation } from "./new-vacation";
import { ReviewList } from "./review-list";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const HOME = "0b6f6c55-3a4e-4f7a-9f15-9a8a1d0c0001";
const VACATION = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0070";
const PARTICIPANT = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0071";
const OCCURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const CHORE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0015";
const ME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0041";
const BEA = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0042";
const CAL = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0043";

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
});
afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
});

function impact(extra: Partial<VacationImpact> = {}): VacationImpact {
  return {
    changes: [
      {
        occurrenceId: OCCURRENCE,
        choreId: CHORE,
        title: "Take out the bins",
        date: "2026-10-23",
        dueDate: "2026-10-23",
        change: "substituted",
        from: [ME],
        to: [BEA],
        for: ME,
      },
    ],
    review: [],
    startsOn: "2026-10-22",
    endsOn: "2026-10-28",
    pauseDates: [],
    fullDates: [],
    ...extra,
  };
}

function item(extra: Partial<ReviewItem> = {}): ReviewItem {
  return {
    occurrenceId: OCCURRENCE,
    choreId: CHORE,
    title: "Water the plants",
    kind: "one_off",
    scheduledDate: "2026-10-23",
    dueDate: "2026-10-23",
    status: "open",
    inRework: false,
    claimed: false,
    reason: "away",
    protected: false,
    revision: 2,
    substituteFor: null,
    assignees: [ME],
    away: [ME],
    decision: null,
    ...extra,
  };
}

describe("recording a vacation", () => {
  it("previews, then confirms exactly the previewed body with the same id", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ outcome: "preview", impact: impact(), revision: null }),
      )
      .mockResolvedValueOnce(
        Response.json({ outcome: "created", impact: impact(), revision: 1 }, { status: 201 }),
      );
    const { container } = renderWithQuery(
      <NewVacation
        homeId={HOME}
        members={members}
        today="2026-10-21"
        canManage={false}
        formats={formats}
      />,
    );
    await user.click(screen.getByTestId("vacation-new-open"));
    await user.type(screen.getByLabelText(/Name/), "Autumn break");
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByTestId("vacation-new-preview"));
    const preview = await screen.findByTestId("vacation-impact");
    expect(within(preview).getByText(/Bea instead of you/i)).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByTestId("vacation-new-confirm"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const [first, second] = fetchMock.mock.calls.map(([, init]) => bodyOf(init));
    expect(first).toMatchObject({
      homeId: HOME,
      name: "Autumn break",
      people: [{ memberId: ME, startsOn: "2026-10-22", endsOn: "2026-10-28" }],
      reminderDays: null,
      dryRun: true,
    });
    expect(second).toEqual({ ...(first as object), dryRun: false });
    expect(await screen.findByText("Vacation saved.")).toBeInTheDocument();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("drops the preview when a field changes, so nothing unseen is confirmed", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      Response.json({ outcome: "preview", impact: impact(), revision: null }),
    );
    renderWithQuery(
      <NewVacation
        homeId={HOME}
        members={members}
        today="2026-10-21"
        canManage={false}
        formats={formats}
      />,
    );
    await user.click(screen.getByTestId("vacation-new-open"));
    await user.click(screen.getByTestId("vacation-new-preview"));
    await screen.findByTestId("vacation-new-confirm");
    await user.type(screen.getByLabelText(/Name/), "x");
    expect(screen.queryByTestId("vacation-new-confirm")).toBeNull();
    expect(screen.getByTestId("vacation-new-preview")).toBeVisible();
  });

  it("refuses the same member twice without asking the server", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <NewVacation
        homeId={HOME}
        members={members}
        today="2026-10-21"
        canManage
        formats={formats}
      />,
    );
    await user.click(screen.getByTestId("vacation-new-open"));
    await user.click(screen.getByTestId("vacation-add-row"));
    const rows = screen.getAllByTestId("vacation-person-row");
    await user.selectOptions(within(rows[0] as HTMLElement).getByLabelText("Member"), BEA);
    await user.selectOptions(within(rows[1] as HTMLElement).getByLabelText("Member"), BEA);
    await user.click(screen.getByTestId("vacation-new-preview"));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("answering an invitation", () => {
  it("shows the personal impact before accepting and sends the revision", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ outcome: "preview", impact: impact(), revision: null }),
      )
      .mockResolvedValueOnce(Response.json({ outcome: "saved", impact: impact(), revision: 2 }));
    const { container } = renderWithQuery(
      <InvitationActions
        participantId={PARTICIPANT}
        revision={1}
        label="Autumn break"
        names={memberNames(members)}
        formats={formats}
      />,
    );
    await user.click(screen.getByTestId("vacation-invitation-accept"));
    expect(await screen.findByTestId("vacation-impact")).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByTestId("vacation-invitation-confirm"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/vacation-participants/${PARTICIPANT}`);
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toEqual({
      expectedRevision: 1,
      action: "accept",
      dryRun: false,
    });
    expect(await screen.findByText("Accepted.")).toBeInTheDocument();
  });

  it("explains an invitation that expired", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(Response.json({ error: "expired" }, { status: 409 }));
    renderWithQuery(
      <InvitationActions
        participantId={PARTICIPANT}
        revision={1}
        label="Autumn break"
        names={memberNames(members)}
        formats={formats}
      />,
    );
    await user.click(screen.getByTestId("vacation-invitation-decline"));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("deciding an affected chore", () => {
  const list = (items: readonly ReviewItem[], canDecide = true) => (
    <ReviewList
      homeId={HOME}
      source={{ kind: "vacation", id: VACATION }}
      items={items}
      planned={[]}
      canDecide={canDecide}
      today="2026-10-21"
      members={members}
      formats={formats}
    />
  );

  it("reassigns to a member away only after the warning is confirmed", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(
        Response.json(
          { error: "member-away", impact: { member: BEA, days: ["2026-10-23"] } },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ outcome: "decided", impact: null, revision: 3 }));
    const { container } = renderWithQuery(list([item()]));
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByTestId("decision-reassign-open"));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("Member"), BEA);
    await user.click(within(dialog).getByTestId("decision-reassign-next"));
    expect(await within(dialog).findByText(/away on a Home vacation/)).toBeVisible();
    await user.click(within(dialog).getByLabelText(/Assign even if they are away/));
    await user.click(within(dialog).getByTestId("decision-reassign-next"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/chore-vacation-decisions");
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      sourceKind: "vacation",
      sourceId: VACATION,
      occurrenceId: OCCURRENCE,
      expectedRevision: 2,
      decision: "reassign",
      memberId: BEA,
    });
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toMatchObject({ confirmAway: true });
    expect(await screen.findByText("Decision saved.")).toBeInTheDocument();
  });

  it("asks for a member before sending a reassignment", async () => {
    const user = userEvent.setup();
    renderWithQuery(list([item()]));
    await user.click(screen.getByTestId("decision-reassign-open"));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByTestId("decision-reassign-next"));
    expect(await within(dialog).findByRole("alert")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers no decision on protected work, a decided item or to members", () => {
    const { unmount } = renderWithQuery(
      list([item({ protected: true, status: "pending_approval" })]),
    );
    expect(screen.queryByTestId("decision-skip-open")).toBeNull();
    unmount();
    const decided = renderWithQuery(
      list([
        item({
          decision: {
            decision: "skip",
            at: "2026-10-21T08:00:00Z",
            by: null,
            to: null,
            newDate: null,
          },
        }),
      ]),
    );
    expect(screen.getByTestId("vacation-review-decision")).toBeVisible();
    expect(screen.queryByTestId("decision-skip-open")).toBeNull();
    decided.unmount();
    renderWithQuery(list([item()], false));
    expect(screen.queryByTestId("decision-skip-open")).toBeNull();
  });

  it("offers rescheduling only for a one-off chore", () => {
    renderWithQuery(list([item({ kind: "recurring" })]));
    expect(screen.queryByTestId("decision-reschedule-open")).toBeNull();
    expect(screen.getByTestId("decision-keep-open")).toBeVisible();
  });
});
