import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ChoreCategory, ChoreOccurrenceDetail, ChoreTemplate } from "@/chores/api";
import type { DateTimeFormats } from "@/invitations/format";
import { axeViolations } from "@/test/axe";
import { renderWithQuery } from "@/test/intl";

import { CategoryManager } from "./category-manager";
import { ChoreBulk } from "./chore-bulk";
import { ChoreChecklist } from "./chore-checklist";
import { ChoreDelete } from "./chore-delete";
import { ChoreEdit } from "./chore-edit";
import { ChoreStatus } from "./chore-status";
import { NewChore } from "./new-chore";
import { TemplateManager } from "./template-manager";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const HOME = "0b6f6c55-3a4e-4f7a-9f15-9a8a1d0c0001";
const CHORE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0015";
const OCCURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const STEP = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0025";
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
});
afterEach(() => {
  vi.unstubAllGlobals();
  router.refresh.mockClear();
  router.push.mockClear();
});

function occurrence(extra: Partial<ChoreOccurrenceDetail> = {}): ChoreOccurrenceDetail {
  return {
    id: OCCURRENCE,
    homeId: HOME,
    chore: {
      id: CHORE,
      kind: "recurring",
      title: "Take out the bins",
      instructions: null,
      category: null,
      requiresApproval: false,
      revision: 1,
    },
    scheduledDate: "2026-10-21",
    dueDate: "2026-10-21",
    today: "2026-10-21",
    status: "open",
    overdue: false,
    inRework: false,
    minutes: null,
    detached: false,
    needsReassignment: false,
    revision: 2,
    assigneeIds: [BEA],
    assignedToMe: false,
    steps: [],
    completion: null,
    skip: null,
    closedTitle: null,
    closedCategory: null,
    submissions: [],
    events: [],
    schedule: null,
    can: { complete: true, review: false, correct: false, manage: false },
    ...extra,
  };
}

describe("completing a chore", () => {
  it("asks who did someone else's chore and sends the chosen contributor with the note", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      Response.json({
        outcome: "completed",
        completedAt: "2026-10-21T09:00:00Z",
        completedBy: { me: true, member: ME },
        contributor: { me: false, member: BEA },
      }),
    );
    const { container } = renderWithQuery(
      <ChoreStatus occurrence={occurrence()} members={members} formats={formats} />,
    );
    await user.click(screen.getByRole("button", { name: "Complete" }));
    const dialog = await screen.findByRole("dialog", { name: "Complete this chore" });
    // Not the viewer's chore: nobody is preselected, so they must say who did it.
    await user.click(within(dialog).getByRole("button", { name: "Complete" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Choose who did the work.");
    expect(fetchMock).not.toHaveBeenCalled();

    await user.selectOptions(within(dialog).getByLabelText("Who did it"), "Bea");
    await user.type(within(dialog).getByLabelText("Note (optional)"), "  Done\n early ");
    expect(await axeViolations(container)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Complete" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/chore-occurrences/${OCCURRENCE}/completion`);
    expect(init?.method).toBe("PUT");
    expect(bodyOf(init)).toEqual({ contributor: BEA, note: "Done early" });
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
  });

  it("preselects the viewer for their own chore and blocks completing with a required step open", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <ChoreStatus
        occurrence={occurrence({
          assigneeIds: [ME],
          assignedToMe: true,
          steps: [{ id: STEP, label: "Sort the glass", mandatory: true, checked: false }],
        })}
        members={members}
        formats={formats}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Complete" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Who did it")).toHaveValue(ME);
    expect(dialog).toHaveTextContent("One required step is not ticked yet.");
    expect(within(dialog).getByRole("button", { name: "Complete" })).toBeDisabled();
  });

  it("tells who was first when someone else completed it at the same time", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      Response.json({
        outcome: "already_completed",
        completedAt: "2026-10-21T08:00:00Z",
        completedBy: { me: false, member: CAL },
        contributor: { me: false, member: CAL },
      }),
    );
    renderWithQuery(
      <ChoreStatus
        occurrence={occurrence({ assigneeIds: [], assignedToMe: false })}
        members={members}
        formats={formats}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Complete" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Complete" }),
    );
    expect(await screen.findByText("Cal had already completed this chore.")).toBeInTheDocument();
  });

  it("shows the record of a completed occurrence and lets a manager reopen it", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(Response.json({ outcome: "reopened", revision: 4 }));
    renderWithQuery(
      <ChoreStatus
        occurrence={occurrence({
          status: "completed",
          completion: {
            at: "2026-10-21T09:00:00Z",
            by: { me: true, member: ME },
            contributor: { me: false, member: BEA },
            note: "Rinsed too",
            approvedAt: null,
            approvedBy: null,
          },
          can: { complete: false, review: false, correct: false, manage: true },
        })}
        members={members}
        formats={formats}
      />,
    );
    expect(screen.getByTestId("chore-status")).toHaveTextContent("Done by Bea, recorded by you");
    expect(screen.getByTestId("chore-note")).toHaveTextContent("Rinsed too");
    expect(screen.queryByRole("button", { name: "Complete" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/chore-occurrences/${OCCURRENCE}/reopen`);
    });
  });
});

describe("the checklist", () => {
  it("ticks a step with a set-to-state request and marks required steps in text", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(Response.json({ checked: true, done: 1, total: 1 }));
    const { container } = renderWithQuery(
      <ChoreChecklist
        occurrence={occurrence({
          steps: [{ id: STEP, label: "Sort the glass", mandatory: true, checked: false }],
        })}
      />,
    );
    expect(screen.getByText("Required")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: /Sort the glass/ }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/chore-occurrences/${OCCURRENCE}/steps/${STEP}`);
    expect(bodyOf(init)).toEqual({ checked: true });
    expect(await axeViolations(container)).toEqual([]);
  });

  it("is read only once the occurrence is closed", () => {
    renderWithQuery(
      <ChoreChecklist
        occurrence={occurrence({
          status: "skipped",
          steps: [{ id: STEP, label: "Sort the glass", mandatory: false, checked: true }],
        })}
      />,
    );
    expect(screen.getByRole("checkbox", { name: /Sort the glass/ })).toBeDisabled();
  });
});

describe("a new chore", () => {
  it("builds a weekly rotation with the keyboard, previews whose turn it is and sends it", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      Response.json({ outcome: "created", occurrenceId: OCCURRENCE }, { status: 201 }),
    );
    const { container } = renderWithQuery(
      <NewChore
        homeId={HOME}
        categories={[{ id: CATEGORY, name: "Kitchen" }]}
        members={members}
        today="2026-10-21"
        dateFormat="ymd-dash"
      />,
    );
    await user.click(screen.getByRole("button", { name: "New chore" }));
    await user.type(screen.getByLabelText(/^Title/), "Take out the bins");
    await user.selectOptions(screen.getByLabelText("Category"), "Kitchen");
    await user.selectOptions(screen.getByTestId("repeat-frequency"), "weekly");
    await user.click(screen.getByRole("radio", { name: "Rotation" }));
    await user.selectOptions(screen.getByTestId("rotation-add-select"), "Bea");
    await user.click(screen.getByTestId("rotation-add"));
    await user.selectOptions(screen.getByTestId("rotation-add-select"), "Cal");
    await user.click(screen.getByTestId("rotation-add"));
    // Cal first: moved with a button, not dragged.
    await user.click(screen.getByRole("button", { name: "Move Cal up" }));
    const preview = screen.getByTestId("rotation-preview");
    expect(
      within(preview)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "2026-10-21: Cal",
      "2026-10-28: Bea",
      "2026-11-04: Cal",
      "2026-11-11: Bea",
      "2026-11-18: Cal",
    ]);
    await user.click(screen.getByTestId("chore-add-step"));
    await user.type(screen.getByLabelText("Step 1"), "Sort the glass");
    await user.click(screen.getByLabelText("Required before completing"));
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByTestId("chore-submit"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/chores");
    expect(bodyOf(init)).toMatchObject({
      homeId: HOME,
      title: "Take out the bins",
      categoryId: CATEGORY,
      instructions: null,
      minutes: null,
      steps: [{ label: "Sort the glass", mandatory: true }],
      assignment: { mode: "rotating", members: [CAL, BEA] },
      dueDate: null,
      recurrence: {
        frequency: "weekly",
        interval: 1,
        weekdays: [3],
        startsOn: "2026-10-21",
        endsOn: null,
        count: null,
      },
    });
    expect(await screen.findByRole("button", { name: "Open the new chore" })).toBeInTheDocument();
  });

  it("does not offer a rotation for a one-off chore and needs two people for one", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <NewChore
        homeId={HOME}
        categories={[]}
        members={members}
        today="2026-10-21"
        dateFormat="ymd-dash"
      />,
    );
    await user.click(screen.getByRole("button", { name: "New chore" }));
    expect(screen.queryByRole("radio", { name: "Rotation" })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Title/), "Bins");
    await user.selectOptions(screen.getByTestId("repeat-frequency"), "daily");
    await user.click(screen.getByRole("radio", { name: "Rotation" }));
    await user.selectOptions(screen.getByTestId("rotation-add-select"), "Bea");
    await user.click(screen.getByTestId("rotation-add"));
    await user.click(screen.getByTestId("chore-submit"));
    expect(await screen.findByText("A rotation needs at least two members.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("editing", () => {
  const schedule: NonNullable<ChoreOccurrenceDetail["schedule"]> = {
    revision: 4,
    frequency: "weekly",
    interval: 1,
    weekdays: [3],
    startsOn: "2026-10-14",
    endsOn: null,
    count: null,
    assignment: "rotating",
    rotationFrom: "2026-10-14",
    members: [BEA, CAL],
    minutes: null,
    steps: [],
    paused: null,
    ended: false,
    finished: false,
    inHead: true,
    needsReassignment: false,
    next: [],
  };

  it("sends only what changed for this and following, after a preview", async () => {
    const user = userEvent.setup();
    const impact = {
      scope: "following",
      updated: 1,
      kept: 0,
      removed: 0,
      completed: 0,
      overdueKept: 0,
      stepsKept: 0,
      selectedRemoved: false,
      next: [{ date: "2026-10-21", assigneeIds: [CAL] }],
    };
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ outcome: "preview", impact, occurrenceId: OCCURRENCE }),
      )
      .mockResolvedValueOnce(Response.json({ outcome: "saved", impact, occurrenceId: OCCURRENCE }));
    const { container } = renderWithQuery(
      <ChoreEdit
        occurrence={occurrence({
          can: { complete: true, review: false, correct: false, manage: true },
          schedule,
        })}
        members={members}
        dateFormat="ymd-dash"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Change this occurrence or the series" }));
    await user.click(screen.getByRole("radio", { name: /This and following occurrences/ }));
    await user.click(screen.getByRole("button", { name: "Move Cal up" }));
    await user.click(screen.getByRole("button", { name: "Preview the change" }));
    expect(await screen.findByTestId("chore-edit-preview")).toHaveTextContent(
      "One occurrence is updated",
    );
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      scope: "following",
      expectedRevision: 2,
      expectedScheduleRevision: 4,
      assignment: { mode: "rotating", members: [CAL, BEA] },
      dryRun: true,
    });
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toMatchObject({ dryRun: false });
    });
  });

  it("names members away on a Home vacation and confirms assigning them on save (S22)", async () => {
    const user = userEvent.setup();
    const impact = { removed: 1, removedChecked: 0, added: 0, newlyMandatory: 0, away: [CAL] };
    fetchMock
      .mockResolvedValueOnce(Response.json({ outcome: "preview", impact, revision: 2 }))
      .mockResolvedValueOnce(Response.json({ outcome: "saved", impact, revision: 3 }));
    renderWithQuery(
      <ChoreEdit
        occurrence={occurrence({
          can: { complete: true, review: false, correct: false, manage: true },
          steps: [{ id: STEP, label: "Sort the glass", mandatory: false, checked: false }],
        })}
        members={members}
        dateFormat="ymd-dash"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Change this occurrence" }));
    await user.click(screen.getByRole("button", { name: "Remove step 1" }));
    await user.click(screen.getByRole("button", { name: "Preview the change" }));
    expect(await screen.findByTestId("chore-edit-away")).toHaveTextContent("Cal");
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).not.toHaveProperty("confirmAway");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toMatchObject({
        dryRun: false,
        confirmAway: true,
      });
    });
  });

  it("asks to confirm removing a ticked step of this occurrence", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          outcome: "preview",
          impact: { removed: 1, removedChecked: 1, added: 0, newlyMandatory: 0 },
          revision: 2,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          outcome: "preview",
          impact: { removed: 1, removedChecked: 1, added: 0, newlyMandatory: 0 },
          revision: 2,
        }),
      );
    renderWithQuery(
      <ChoreEdit
        occurrence={occurrence({
          can: { complete: true, review: false, correct: false, manage: true },
          steps: [{ id: STEP, label: "Sort the glass", mandatory: false, checked: true }],
        })}
        members={members}
        dateFormat="ymd-dash"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Change this occurrence" }));
    await user.click(screen.getByRole("button", { name: "Remove step 1" }));
    await user.click(screen.getByRole("button", { name: "Preview the change" }));
    await screen.findByTestId("chore-edit-preview");
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    await user.click(screen.getByTestId("chore-confirm-checklist"));
    await user.click(screen.getByRole("button", { name: "Preview the change" }));
    expect(await screen.findByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toEqual({
      expectedRevision: 2,
      steps: [],
      confirmChecklist: true,
      dryRun: true,
    });
  });
});

describe("deleting", () => {
  it("previews what goes to the trash for the chosen scope before moving it", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          outcome: "preview",
          impact: { scope: "occurrence", removed: 1, kept: 0 },
          entryId: null,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          outcome: "preview",
          impact: { scope: "series", removed: 2, kept: 3 },
          entryId: null,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          outcome: "deleted",
          impact: { scope: "series", removed: 2, kept: 3 },
          entryId: STEP,
        }),
      );
    const detail = occurrence({
      can: { complete: true, review: false, correct: false, manage: true },
      schedule: {
        revision: 1,
        frequency: "weekly",
        interval: 1,
        weekdays: [3],
        startsOn: "2026-10-21",
        endsOn: null,
        count: null,
        assignment: "fixed",
        rotationFrom: null,
        members: [BEA],
        minutes: null,
        steps: [],
        paused: null,
        ended: false,
        finished: false,
        inHead: true,
        needsReassignment: false,
        next: [],
      },
    });
    renderWithQuery(<ChoreDelete occurrence={detail} homeId={HOME} />);
    await user.click(screen.getByRole("button", { name: "Delete occurrences" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => {
      expect(within(dialog).getByTestId("chore-delete-impact")).toHaveTextContent(
        "One open occurrence goes to the trash",
      );
    });
    await user.click(within(dialog).getByRole("radio", { name: /The entire series/ }));
    await waitFor(() => {
      expect(within(dialog).getByTestId("chore-delete-impact")).toHaveTextContent(
        "2 open occurrences go to the trash; 3 done or skipped occurrences stay.",
      );
    });
    await user.click(within(dialog).getByRole("button", { name: "Move to trash" }));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(`/homes/${HOME}/chores?deleted=1`);
    });
    expect(bodyOf(fetchMock.mock.calls[2]?.[1])).toEqual({
      scope: "series",
      dryRun: false,
      expectedRevision: 2,
    });
  });
});

describe("categories", () => {
  const kitchen: ChoreCategory = {
    id: CATEGORY,
    name: "Kitchen",
    color: null,
    position: 0,
    archived: false,
    revision: 1,
    choreCount: 2,
  };

  it("says when a name is taken and previews a deletion's impact", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: "duplicate-name" }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ outcome: "preview", choreCount: 2 }));
    const { container } = renderWithQuery(<CategoryManager homeId={HOME} categories={[kitchen]} />);
    await user.type(screen.getByLabelText("Category name"), " kitchen ");
    await user.click(screen.getByRole("button", { name: "Add category" }));
    expect(await screen.findByText("That name is already used in this Home.")).toBeInTheDocument();
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({ homeId: HOME, name: "kitchen" });

    await user.click(screen.getByRole("button", { name: "Delete Kitchen" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Kitchen is on 2 chores, which become uncategorized.");
    expect(await axeViolations(container)).toEqual([]);
  });

  it("renders in Dutch", () => {
    renderWithQuery(<CategoryManager homeId={HOME} categories={[kitchen]} />, "nl");
    expect(screen.getByRole("heading", { name: "Categorieën" })).toBeInTheDocument();
    expect(screen.getByText("bij 2 klusjes")).toBeInTheDocument();
  });
});

describe("approval", () => {
  const pending = {
    id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0060",
    attempt: 1,
    status: "pending" as const,
    at: "2026-10-21T09:00:00Z",
    by: { me: false, member: BEA },
    contributor: { me: false, member: BEA },
    note: "All sorted",
    steps: [{ label: "Sort", mandatory: true, checked: true }],
    decidedAt: null,
    decidedBy: null,
    reason: null,
    selfApproved: false,
  };

  it("submits instead of completing a chore that needs approval", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      Response.json({
        outcome: "submitted",
        completedAt: "2026-10-21T09:00:00Z",
        completedBy: { me: true, member: ME },
        contributor: { me: true, member: ME },
      }),
    );
    renderWithQuery(
      <ChoreStatus
        occurrence={occurrence({
          assigneeIds: [ME],
          assignedToMe: true,
          chore: { ...occurrence().chore, requiresApproval: true },
        })}
        members={members}
        formats={formats}
      />,
    );
    expect(
      screen.getByText("Completing this chore submits it for a reviewer's approval."),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Submit for approval" }));
    const dialog = await screen.findByRole("dialog", { name: "Submit this chore for approval" });
    await user.click(within(dialog).getByRole("button", { name: "Submit for approval" }));
    expect(
      await screen.findByText("Take out the bins is submitted for approval."),
    ).toBeInTheDocument();
  });

  it("lets a reviewer reject only with a reason, then approve another", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(Response.json({ outcome: "rejected", revision: 4 }));
    const { container } = renderWithQuery(
      <ChoreStatus
        occurrence={occurrence({
          status: "pending_approval",
          revision: 3,
          chore: { ...occurrence().chore, requiresApproval: true },
          submissions: [pending],
          can: { complete: false, review: true, correct: false, manage: false },
        })}
        members={members}
        formats={formats}
      />,
    );
    expect(screen.getByTestId("chore-status")).toHaveTextContent(
      "Waiting for approval: submitted by Bea (done by Bea)",
    );
    expect(screen.getByTestId("chore-note")).toHaveTextContent("All sorted");
    await user.click(screen.getByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog", { name: "Reject this completion?" });
    await user.click(within(dialog).getByRole("button", { name: "Reject" }));
    expect(within(dialog).getByText("Say why it is rejected.")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText(/Reason/), "Glass left");
    expect(await axeViolations(container)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Reject" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/v1/chore-occurrences/${OCCURRENCE}/review`);
    expect(bodyOf(init)).toEqual({ expectedRevision: 3, decision: "reject", reason: "Glass left" });
  });

  it("shows Needs rework with the reason and offers resubmission", () => {
    renderWithQuery(
      <ChoreStatus
        occurrence={occurrence({
          inRework: true,
          overdue: true,
          chore: { ...occurrence().chore, requiresApproval: true },
          submissions: [
            {
              ...pending,
              status: "rejected",
              decidedAt: "2026-10-21T10:00:00Z",
              decidedBy: { me: true, member: ME },
              reason: "Glass left",
            },
          ],
        })}
        members={members}
        formats={formats}
      />,
    );
    expect(screen.getByTestId("chore-status")).toHaveTextContent("Needs rework and overdue");
    expect(screen.getByTestId("chore-rework")).toHaveTextContent("Rejected by you");
    expect(screen.getByTestId("chore-rework")).toHaveTextContent("Glass left");
    expect(screen.getByRole("button", { name: "Resubmit for approval" })).toBeVisible();
  });

  it("corrects a completed record's contributor, keeping the rest", async () => {
    const user = userEvent.setup();
    // S23: the dialog reads the points change of the choices first.
    fetchMock.mockImplementation((url: unknown) =>
      Promise.resolve(
        typeof url === "string" && url.includes("/points?preview=correct")
          ? Response.json({ change: null })
          : Response.json({ outcome: "corrected", revision: 6 }),
      ),
    );
    renderWithQuery(
      <ChoreStatus
        occurrence={occurrence({
          status: "completed",
          revision: 5,
          completion: {
            at: "2026-10-21T09:00:00Z",
            by: { me: true, member: ME },
            contributor: { me: false, member: BEA },
            note: "Rinsed",
            approvedAt: "2026-10-21T10:00:00Z",
            approvedBy: { me: true, member: ME },
          },
          submissions: [{ ...pending, status: "approved", selfApproved: true }],
          can: { complete: false, review: false, correct: true, manage: true },
        })}
        members={members}
        formats={formats}
      />,
    );
    expect(screen.getByTestId("chore-approved")).toHaveTextContent("Approved by you");
    expect(screen.getByTestId("chore-approved")).toHaveTextContent("(Self-approved.)");
    await user.click(screen.getByRole("button", { name: "Correct the record" }));
    const dialog = await screen.findByRole("dialog", { name: "Correct this completion" });
    expect(within(dialog).getByLabelText("Done on")).toHaveValue("2026-10-21");
    expect(within(dialog).getByLabelText("At")).toHaveValue("11:00");
    await user.selectOptions(within(dialog).getByLabelText("Who did it"), "Cal");
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/v1/chore-occurrences/${OCCURRENCE}/points?preview=correct&contributor=${CAL}`,
        expect.anything(),
      );
    });
    await user.click(within(dialog).getByRole("button", { name: "Save the correction" }));
    const save = () =>
      fetchMock.mock.calls.find(
        ([url]) => typeof url === "string" && url.endsWith("/completion-record"),
      );
    await waitFor(() => {
      expect(save()).toBeDefined();
    });
    const [url, init] = save() ?? [];
    expect(url).toBe(`/api/v1/chore-occurrences/${OCCURRENCE}/completion-record`);
    expect(bodyOf(init)).toEqual({ expectedRevision: 5, contributor: CAL, reason: null });
  });
});

describe("templates", () => {
  const TEMPLATE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0070";
  const bathroom: ChoreTemplate = {
    id: TEMPLATE,
    title: "Bathroom",
    instructions: "Top to bottom",
    category: { id: CATEGORY, name: "Kitchen", color: null, archived: false },
    minutes: 30,
    steps: [
      { label: "Mirror", mandatory: false },
      { label: "Toilet", mandatory: true },
    ],
    retired: false,
    revision: 2,
    points: { points: 5, latePolicy: "full", latePoints: null },
  };

  it("duplicates a template into a new one and retires another", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(Response.json({ outcome: "created", revision: 1 }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ outcome: "saved", revision: 3 }));
    const { container } = renderWithQuery(
      <TemplateManager
        homeId={HOME}
        templates={[bathroom]}
        categories={[{ id: CATEGORY, name: "Kitchen" }]}
      />,
    );
    expect(screen.getByText("2 steps, 1 required")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Duplicate template Bathroom" }));
    expect(screen.getByLabelText(/^Template title/)).toHaveValue("Bathroom (copy)");
    expect(screen.getByLabelText("Category")).toHaveValue(CATEGORY);
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Add template" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/chore-templates");
    expect(bodyOf(init)).toMatchObject({
      homeId: HOME,
      title: "Bathroom (copy)",
      instructions: "Top to bottom",
      categoryId: CATEGORY,
      minutes: 30,
      steps: [
        { label: "Mirror", mandatory: false },
        { label: "Toilet", mandatory: true },
      ],
    });

    await user.click(await screen.findByRole("button", { name: "Retire template Bathroom" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const [retireUrl, retireInit] = fetchMock.mock.calls[1] ?? [];
    expect(retireUrl).toBe(`/api/v1/chore-templates/${TEMPLATE}`);
    expect(bodyOf(retireInit)).toMatchObject({
      expectedRevision: 2,
      retired: true,
      title: "Bathroom",
    });
  });

  it("copies a template into the new-chore form, leaving who and when to choose", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      Response.json({ outcome: "created", occurrenceId: OCCURRENCE }, { status: 201 }),
    );
    renderWithQuery(
      <NewChore
        homeId={HOME}
        categories={[]}
        members={members}
        today="2026-10-21"
        dateFormat="ymd-dash"
        templates={[bathroom]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "New chore" }));
    await user.selectOptions(screen.getByLabelText("Start from a template"), "Bathroom");
    await user.click(screen.getByRole("button", { name: "Copy into the form" }));
    expect(screen.getByLabelText(/^Title/)).toHaveValue("Bathroom");
    // The template's category is not offered here, so it is not copied.
    expect(screen.getByLabelText("Category")).toHaveValue("");
    await user.clear(screen.getByLabelText(/^Title/));
    await user.type(screen.getByLabelText(/^Title/), "Upstairs bathroom");
    await user.click(screen.getByTestId("chore-submit"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      title: "Upstairs bathroom",
      instructions: "Top to bottom",
      categoryId: null,
      minutes: 30,
      steps: [
        { label: "Mirror", mandatory: false },
        { label: "Toilet", mandatory: true },
      ],
      assignment: { mode: "none", members: [] },
      requiresApproval: false,
    });
  });
});

describe("changing several occurrences", () => {
  const OTHER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021";
  const rows = [
    { id: OCCURRENCE, title: "Bins", dueDate: "2026-10-21", revision: 2, pending: false },
    { id: OTHER, title: "Windows", dueDate: "2026-10-20", revision: 5, pending: true },
  ];
  const result = (id: string, outcome: string, revision: number) => ({
    occurrenceId: id,
    outcome,
    title: id === OCCURRENCE ? "Bins" : "Windows",
    dueBefore: "2026-10-21",
    dueAfter: outcome === "pending_approval" ? null : "2026-10-21",
    assigneesBefore: [BEA],
    assigneesAfter: outcome === "pending_approval" ? null : [CAL],
    revision,
  });

  it("previews each occurrence, applies only the eligible ones and reports the rest", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          action: "reassign",
          dryRun: true,
          results: [result(OCCURRENCE, "preview", 2), result(OTHER, "pending_approval", 5)],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          action: "reassign",
          dryRun: false,
          results: [result(OCCURRENCE, "saved", 3)],
        }),
      );
    const { container } = renderWithQuery(
      <ChoreBulk
        homeId={HOME}
        rows={rows}
        members={members}
        today="2026-10-21"
        dateFormat="ymd-dash"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Change several" }));
    await user.click(screen.getByRole("button", { name: "Select all shown (2)" }));
    expect(screen.getByTestId("chore-bulk-count")).toHaveTextContent("2 selected");
    await user.selectOptions(screen.getByLabelText("Assign to"), "Cal");
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Review the change for 2" }));
    const dialog = await screen.findByRole("dialog", { name: "Review: Reassign" });
    expect(dialog).toHaveTextContent("1 of 2 selected will change.");
    expect(dialog).toHaveTextContent("Bea → Cal");
    expect(dialog).toHaveTextContent("Not changed: it waits for approval");
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      homeId: HOME,
      action: "reassign",
      items: [
        { id: OCCURRENCE, revision: 2 },
        { id: OTHER, revision: 5 },
      ],
      dryRun: true,
      member: CAL,
    });
    await user.click(within(dialog).getByRole("button", { name: "Change 1" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toMatchObject({
      items: [{ id: OCCURRENCE, revision: 2 }],
      dryRun: false,
    });
    expect(await screen.findByTestId("chore-bulk-results")).toHaveTextContent(
      "1 changed, 1 not changed.",
    );
    expect(screen.getByTestId("chore-bulk-results")).toHaveTextContent(
      "Windows: it waits for approval",
    );
    expect(router.refresh).toHaveBeenCalled();
  });
});
