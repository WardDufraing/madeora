// S21: proposing and reviewing chores, volunteer invitations, the manager's request, roster and
// correction. The database decides every right, the first acceptance and the deadline
// (tests/db/rls/chore-proposals-volunteers.test.sql); these tests check what the interface sends,
// shows and keeps to itself.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ChoreProposal, ChoreVolunteerState, VolunteerOffer } from "@/chores/api";
import type { DateTimeFormats } from "@/invitations/format";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { ProposalActions, ProposeChore } from "./chore-proposals";
import { ChoreVolunteerPanel, VolunteerOffers } from "./chore-volunteers";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const HOME = "0b6f6c55-3a4e-4f7a-9f15-9a8a1d0c0001";
const PROPOSAL = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0015";
const OCCURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const REQUEST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0060";
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

function proposal(extra: Partial<ChoreProposal> = {}): ChoreProposal {
  return {
    id: PROPOSAL,
    status: "pending",
    title: "Clean the windows",
    instructions: null,
    category: null,
    minutes: 20,
    steps: [{ label: "Inside", mandatory: true }],
    dueDate: "2026-10-25",
    feedback: null,
    revised: false,
    by: { me: false, member: BEA },
    createdAt: "2026-10-21T08:00:00Z",
    decidedAt: null,
    decidedBy: null,
    revision: 1,
    occurrenceId: null,
    canWithdraw: false,
    canReview: true,
    possibleDuplicate: false,
    ...extra,
  };
}

describe("proposing a chore", () => {
  it("sends the proposal with a fresh id and closes the form", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      Response.json({ outcome: "proposed", revision: 1 }, { status: 201 }),
    );
    const { container } = renderWithQuery(
      <ProposeChore homeId={HOME} categories={[]} today="2026-10-21" />,
    );
    await user.click(screen.getByTestId("propose-open"));
    await user.type(screen.getByLabelText(/Title/), "Clean the windows");
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByTestId("propose-form-submit"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/chore-proposals");
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      homeId: HOME,
      title: "Clean the windows",
      dueDate: "2026-10-21",
      steps: [],
      categoryId: null,
    });
    expect((bodyOf(fetchMock.mock.calls[0]?.[1]) as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => {
      expect(screen.getByTestId("propose-open")).toBeVisible();
    });
    expect(await screen.findByText("Proposal sent for review.")).toBeInTheDocument();
  });

  it("explains a duplicate title", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(Response.json({ error: "duplicate" }, { status: 409 }));
    renderWithQuery(<ProposeChore homeId={HOME} categories={[]} today="2026-10-21" />);
    await user.click(screen.getByTestId("propose-open"));
    await user.type(screen.getByLabelText(/Title/), "Clean the windows");
    await user.click(screen.getByTestId("propose-form-submit"));
    expect(
      await screen.findByText("You already have a proposal waiting with this title."),
    ).toBeVisible();
  });
});

describe("reviewing a proposal", () => {
  it("approves the revised values after showing them", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      Response.json({ outcome: "approved", occurrenceId: OCCURRENCE }),
    );
    renderWithQuery(
      <ProposalActions
        proposal={proposal()}
        categories={[]}
        today="2026-10-21"
        formats={formats}
      />,
    );
    await user.click(screen.getByTestId("proposal-review-open"));
    const title = screen.getByLabelText(/Title/);
    await user.clear(title);
    await user.type(title, "Clean all windows");
    await user.click(screen.getByTestId("proposal-revise-form-submit"));
    const final = await screen.findByTestId("proposal-final");
    expect(final).toHaveTextContent("Clean all windows");
    expect(final).toHaveTextContent("1 checklist step");
    expect(final).toHaveTextContent("Nobody yet: it goes to the pool");
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("proposal-approve-confirm"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/chore-proposals/${PROPOSAL}`);
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      expectedRevision: 1,
      action: "approve",
      title: "Clean all windows",
      instructions: null,
      categoryId: null,
      minutes: 20,
      steps: [{ label: "Inside", mandatory: true }],
      dueDate: "2026-10-25",
    });
  });

  it("needs a reason to reject", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(Response.json({ outcome: "rejected", occurrenceId: null }));
    renderWithQuery(
      <ProposalActions
        proposal={proposal()}
        categories={[]}
        today="2026-10-21"
        formats={formats}
      />,
    );
    await user.click(screen.getByTestId("proposal-reject-open"));
    await user.click(screen.getByTestId("proposal-reject-confirm"));
    expect(fetchMock).not.toHaveBeenCalled();
    await user.type(screen.getByTestId("proposal-reject-reason"), "We already have one");
    await user.click(screen.getByTestId("proposal-reject-confirm"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      expectedRevision: 1,
      action: "reject",
      reason: "We already have one",
    });
  });

  it("offers only withdrawal to the proposer who cannot review", () => {
    renderWithQuery(
      <ProposalActions
        proposal={proposal({ canReview: false, canWithdraw: true })}
        categories={[]}
        today="2026-10-21"
        formats={formats}
      />,
    );
    expect(screen.getByTestId("proposal-withdraw-open")).toBeVisible();
    expect(screen.queryByTestId("proposal-review-open")).toBeNull();
    expect(screen.queryByTestId("proposal-reject-open")).toBeNull();
  });
});

const offer: VolunteerOffer = {
  requestId: REQUEST,
  occurrenceId: OCCURRENCE,
  title: "Sweep the hall",
  dueDate: "2026-10-23",
  deadline: "2026-10-23T22:00:00Z",
  instructions: "Use the soft brush",
  minutes: 15,
  steps: [{ label: "Corners", mandatory: false }],
  invitedAt: "2026-10-21T08:00:00Z",
};

describe("volunteer invitations", () => {
  it("shows the chore and accepts", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(Response.json({ outcome: "accepted" }));
    const { container } = renderWithQuery(
      <VolunteerOffers homeId={HOME} offers={[offer]} formats={formats} />,
    );
    const item = screen.getByTestId("volunteer-offer");
    expect(item).toHaveTextContent("Sweep the hall");
    expect(item).toHaveTextContent("Use the soft brush");
    expect(item).toHaveTextContent("Corners");
    expect(item).toHaveTextContent("Open until");
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Volunteer for Sweep the hall" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/chore-volunteer-requests/${REQUEST}`);
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ action: "accept" });
    expect(await screen.findByText("You volunteered. The chore is now yours.")).toBeInTheDocument();
  });

  it("refreshes after losing to an earlier volunteer", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "not-open", status: "accepted" }, { status: 409 }),
    );
    renderWithQuery(<VolunteerOffers homeId={HOME} offers={[offer]} formats={formats} />);
    await user.click(screen.getByTestId("volunteer-accept"));
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
  });
});

function volunteerState(extra: Partial<ChoreVolunteerState> = {}): ChoreVolunteerState {
  return {
    inReview: true,
    awaitingVolunteer: false,
    deadline: "2026-10-23T22:00:00Z",
    canRequest: true,
    canCorrect: false,
    volunteer: null,
    requests: [],
    ...extra,
  };
}

describe("the volunteer panel", () => {
  it("previews the deadline before sending a request to the chosen members", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ outcome: "preview", deadline: "2026-10-23T22:00:00Z" }),
      )
      .mockResolvedValueOnce(
        Response.json({ outcome: "sent", deadline: "2026-10-23T22:00:00Z" }, { status: 201 }),
      );
    renderWithQuery(
      <ChoreVolunteerPanel
        occurrenceId={OCCURRENCE}
        revision={3}
        title="Sweep the hall"
        state={volunteerState()}
        members={members}
        formats={formats}
      />,
    );
    await user.click(screen.getByTestId("volunteer-request-open"));
    await user.click(screen.getByTestId("volunteer-request-preview"));
    expect(screen.getByText("Choose between 1 and 20 members.")).toBeVisible();
    await user.click(screen.getByLabelText("Bea"));
    await user.click(screen.getByLabelText("Cal"));
    await user.click(screen.getByTestId("volunteer-request-preview"));
    expect(await screen.findByTestId("volunteer-request-deadline")).toHaveTextContent(
      "2 members are asked.",
    );
    await user.click(screen.getByTestId("volunteer-request-send"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const first = bodyOf(fetchMock.mock.calls[0]?.[1]) as { id: string };
    expect(first).toMatchObject({ expectedRevision: 3, memberIds: [BEA, CAL], dryRun: true });
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toEqual({ ...first, dryRun: false });
  });

  it("shows an invitee only their own invitation and Awaiting volunteer", async () => {
    const { container } = renderWithQuery(
      <ChoreVolunteerPanel
        occurrenceId={OCCURRENCE}
        revision={3}
        title="Sweep the hall"
        state={volunteerState({
          awaitingVolunteer: true,
          canRequest: false,
          requests: [
            {
              id: REQUEST,
              status: "open",
              createdAt: "2026-10-21T08:00:00Z",
              closedAt: null,
              by: null,
              acceptedBy: null,
              canChange: false,
              invitations: [
                {
                  member: { me: true, member: ME },
                  status: "pending",
                  invitedAt: "2026-10-21T08:00:00Z",
                  respondedAt: null,
                  canAnswer: true,
                },
              ],
            },
          ],
        })}
        members={members}
        formats={formats}
      />,
    );
    expect(screen.getByTestId("chore-awaiting-volunteer")).toHaveTextContent("Awaiting volunteer");
    expect(screen.getByTestId("volunteer-accept")).toBeVisible();
    expect(screen.queryByTestId("volunteer-roster")).toBeNull();
    expect(screen.queryByTestId("volunteer-request-open")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("lets a manager withdraw one invitation and invite someone not asked before", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(Response.json({ outcome: "withdrawn", closed: false, skipped: [] }))
      .mockResolvedValueOnce(Response.json({ outcome: "added", closed: false, skipped: [] }));
    const { container } = renderWithQuery(
      <ChoreVolunteerPanel
        occurrenceId={OCCURRENCE}
        revision={3}
        title="Sweep the hall"
        state={volunteerState({
          awaitingVolunteer: true,
          canRequest: false,
          requests: [
            {
              id: REQUEST,
              status: "open",
              createdAt: "2026-10-21T08:00:00Z",
              closedAt: null,
              by: { me: true, member: ME },
              acceptedBy: null,
              canChange: true,
              invitations: [
                {
                  member: { me: false, member: BEA },
                  status: "pending",
                  invitedAt: "2026-10-21T08:00:00Z",
                  respondedAt: null,
                  canAnswer: false,
                },
                {
                  member: { me: true, member: ME },
                  status: "declined",
                  invitedAt: "2026-10-21T08:00:00Z",
                  respondedAt: "2026-10-21T09:00:00Z",
                  canAnswer: false,
                },
              ],
            },
          ],
        })}
        members={members}
        formats={formats}
      />,
    );
    const roster = screen.getByTestId("volunteer-roster");
    expect(roster).toHaveTextContent("Waiting");
    expect(roster).toHaveTextContent("Declined");
    expect(await axeViolations(container)).toEqual([]);
    await user.click(
      within(roster).getByRole("button", { name: "Withdraw the invitation for Bea" }),
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ action: "withdraw", memberIds: [BEA] });
    // Only Cal was not asked before.
    expect(screen.queryByLabelText("Bea")).toBeNull();
    await user.click(screen.getByLabelText("Cal"));
    await user.click(screen.getByTestId("volunteer-add"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toEqual({ action: "add", memberIds: [CAL] });
  });

  it("corrects an accepted volunteer with a reason after a preview", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ outcome: "preview", volunteer: BEA, overdue: true, revision: 6 }),
      )
      .mockResolvedValueOnce(
        Response.json({ outcome: "corrected", volunteer: BEA, overdue: true, revision: 7 }),
      );
    renderWithQuery(
      <ChoreVolunteerPanel
        occurrenceId={OCCURRENCE}
        revision={6}
        title="Sweep the hall"
        state={volunteerState({
          inReview: false,
          canRequest: false,
          canCorrect: true,
          volunteer: { me: false, member: BEA },
        })}
        members={members}
        formats={formats}
      />,
    );
    await user.click(screen.getByTestId("volunteer-correct-open"));
    await user.click(screen.getByTestId("volunteer-correct-preview"));
    expect(fetchMock).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByTestId("volunteer-correct-target"), CAL);
    await user.type(screen.getByTestId("volunteer-correct-reason"), "Bea is away");
    await user.click(screen.getByTestId("volunteer-correct-preview"));
    expect(await screen.findByTestId("volunteer-correct-summary")).toHaveTextContent(
      "Bea is no longer assigned; Cal is. It is already overdue.",
    );
    await user.click(screen.getByTestId("volunteer-correct-confirm"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toEqual({
      expectedRevision: 6,
      reason: "Bea is away",
      memberId: CAL,
      dryRun: false,
    });
  });
});
