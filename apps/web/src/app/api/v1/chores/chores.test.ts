// S20: the chore routes. The database decides rights, scopes, rotation and impact (tests/db/rls/
// chores.test.sql); these tests check what the routes send it and how they answer.
import type { Mock } from "vitest";

import { PATCH as patchCategory } from "../chore-categories/[categoryId]/route";
import { POST as deleteCategory } from "../chore-categories/[categoryId]/delete/route";
import { POST as createCategory, PUT as orderCategories } from "../chore-categories/route";
import { GET as listApprovals } from "../chore-approvals/route";
import { GET as homeHistory } from "../chore-history/route";
import { POST as bulk } from "../chore-occurrences/bulk/route";
import { PATCH as patchTemplate } from "../chore-templates/[templateId]/route";
import { GET as listTemplates, POST as createTemplate } from "../chore-templates/route";
import { PUT as correct } from "../chore-occurrences/[occurrenceId]/completion-record/route";
import { PUT as complete } from "../chore-occurrences/[occurrenceId]/completion/route";
import { POST as removeOccurrences } from "../chore-occurrences/[occurrenceId]/delete/route";
import { POST as reopen } from "../chore-occurrences/[occurrenceId]/reopen/route";
import { POST as review } from "../chore-occurrences/[occurrenceId]/review/route";
import {
  GET as readOccurrence,
  PATCH as changeOccurrence,
} from "../chore-occurrences/[occurrenceId]/route";
import { POST as changeSeries } from "../chore-occurrences/[occurrenceId]/series/route";
import { POST as skip } from "../chore-occurrences/[occurrenceId]/skip/route";
import { PUT as tick } from "../chore-occurrences/[occurrenceId]/steps/[stepId]/route";
import { GET as listOccurrences } from "../chore-occurrences/route";
import { GET as history } from "./[choreId]/history/route";
import { PUT as pause } from "./[choreId]/paused/route";
import { PATCH as patchChore } from "./[choreId]/route";
import { GET as listChores, POST as createChore } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const CHORE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0015";
const OCCURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const STEP = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0025";
const CATEGORY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0030";
const MEMBER_A = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";
const MEMBER_B = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0041";
const ENTRY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0090";
const TEMPLATE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0050";
const OTHER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args: Record<string, unknown>) => Promise.resolve(state.rpc(name, args)),
    }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };
const crossSite = { origin: "https://evil.example", host: "madeora.example" };

function request(path: string, method: string, body?: unknown, headers = sameOrigin): Request {
  return new Request(`https://madeora.example/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const params = <K extends string>(key: K, value: string) => ({
  params: Promise.resolve({ [key]: value } as Record<K, string>),
});
const occurrence = params("occurrenceId", OCCURRENCE);

function answers(outcomes: Record<string, unknown>) {
  state.rpc.mockImplementation((name) =>
    name in outcomes
      ? { data: outcomes[name], error: null }
      : { data: null, error: { code: "XX000", message: "unexpected" } },
  );
}

const weekly = {
  frequency: "weekly",
  interval: 1,
  weekdays: [6, 1],
  startsOn: "2026-10-19",
  endsOn: null,
  count: null,
};
const newChore = {
  id: CHORE,
  homeId: HOME,
  title: "  Take out the bins ",
  instructions: "",
  categoryId: CATEGORY,
  minutes: 15,
  steps: [{ label: "Sort the glass", mandatory: true }],
  assignment: { mode: "rotating", members: [MEMBER_A, MEMBER_B] },
  dueDate: null,
  recurrence: weekly,
};

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
});

describe("creating a chore", () => {
  it("sends the rule, the rotation and the checklist, with a trimmed title", async () => {
    answers({ create_chore: [{ outcome: "created", occurrence_id: OCCURRENCE, revision: 1 }] });
    const response = await createChore(request("/chores", "POST", newChore));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ outcome: "created", occurrenceId: OCCURRENCE });
    expect(state.rpc).toHaveBeenCalledWith("create_chore", {
      p_id: CHORE,
      p_home_id: HOME,
      p_title: "Take out the bins",
      p_assignment: { mode: "rotating", members: [MEMBER_A, MEMBER_B] },
      p_steps: [{ label: "Sort the glass", mandatory: true }],
      p_category_id: CATEGORY,
      p_minutes: 15,
      p_requires_approval: false,
      // S23: no points given means none, paid in full when late.
      p_points: 0,
      p_late_policy: "full",
      p_frequency: "weekly",
      p_interval: 1,
      p_starts_on: "2026-10-19",
      p_weekdays: [1, 6],
    });
  });

  it("sends a one-off chore's due date and no rule", async () => {
    answers({ create_chore: [{ outcome: "created", occurrence_id: OCCURRENCE, revision: 1 }] });
    await createChore(
      request("/chores", "POST", {
        ...newChore,
        assignment: { mode: "none", members: [] },
        recurrence: null,
        dueDate: "2026-10-22",
      }),
    );
    const args = state.rpc.mock.calls[0]?.[1] ?? {};
    expect(args.p_due_date).toBe("2026-10-22");
    expect(args).not.toHaveProperty("p_frequency");
  });

  it("refuses a rotation on a one-off chore, a one-person rotation and both a date and a rule", async () => {
    for (const body of [
      { ...newChore, recurrence: null, dueDate: "2026-10-22" },
      { ...newChore, assignment: { mode: "rotating", members: [MEMBER_A] } },
      { ...newChore, dueDate: "2026-10-22" },
      {
        ...newChore,
        steps: [
          { label: "Sweep", mandatory: false },
          { label: " SWEEP", mandatory: true },
        ],
      },
    ]) {
      const response = await createChore(request("/chores", "POST", body));
      expect(response.status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses cross-site requests and signed-out people before reading the body", async () => {
    expect((await createChore(request("/chores", "POST", newChore, crossSite))).status).toBe(403);
    state.identity = null;
    expect((await createChore(request("/chores", "POST", newChore))).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers the database's refusals", async () => {
    const cases: [string, number, unknown][] = [
      ["not_permitted", 403, { error: "not-permitted" }],
      ["limit_reached", 409, { error: "limit-reached" }],
      ["invalid_category", 400, { error: "invalid", fields: ["categoryId"] }],
      ["invalid_assignee", 400, { error: "invalid", fields: ["assignment"] }],
      ["ended", 409, { error: "schedule-ended" }],
      ["id_taken", 409, { error: "id-taken" }],
    ];
    for (const [outcome, status, body] of cases) {
      answers({ create_chore: [{ outcome, occurrence_id: null, revision: null }] });
      const response = await createChore(request("/chores", "POST", newChore));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
    }
  });

  it("answers not found for a Home the person is not in", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not permitted" } });
    expect((await createChore(request("/chores", "POST", newChore))).status).toBe(404);
  });
});

describe("completing", () => {
  it("names the contributor and sends the normalized note", async () => {
    answers({
      complete_chore_occurrence: [
        {
          outcome: "completed",
          completed_at: "2026-10-21T09:00:00Z",
          completed_by_me: true,
          completed_by_member: MEMBER_A,
          contributor_me: false,
          contributor_member: MEMBER_B,
          open_mandatory: 0,
          revision: 3,
        },
      ],
    });
    const response = await complete(
      request(`/chore-occurrences/${OCCURRENCE}/completion`, "PUT", {
        contributor: MEMBER_B,
        note: "  Done\n\n early ",
      }),
      occurrence,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: "completed",
      completedAt: "2026-10-21T09:00:00Z",
      completedBy: { me: true, member: MEMBER_A },
      contributor: { me: false, member: MEMBER_B },
    });
    expect(state.rpc).toHaveBeenCalledWith("complete_chore_occurrence", {
      p_occurrence_id: OCCURRENCE,
      p_contributor: MEMBER_B,
      p_note: "Done early",
    });
  });

  it("tells who was first, how many mandatory steps are open, and refuses a skipped one", async () => {
    answers({
      complete_chore_occurrence: [
        {
          outcome: "already_completed",
          completed_at: "2026-10-21T08:00:00Z",
          completed_by_me: false,
          completed_by_member: MEMBER_B,
          contributor_me: false,
          contributor_member: MEMBER_B,
          open_mandatory: 0,
          revision: 3,
        },
      ],
    });
    const body = { contributor: MEMBER_A, note: null };
    const path = `/chore-occurrences/${OCCURRENCE}/completion`;
    const first = await complete(request(path, "PUT", body), occurrence);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      outcome: "already_completed",
      completedBy: { me: false, member: MEMBER_B },
    });

    answers({
      complete_chore_occurrence: [
        { outcome: "steps_incomplete", completed_at: null, open_mandatory: 2 },
      ],
    });
    const incomplete = await complete(request(path, "PUT", body), occurrence);
    expect(incomplete.status).toBe(409);
    expect(await incomplete.json()).toEqual({ error: "steps-incomplete", count: 2 });

    answers({ complete_chore_occurrence: [{ outcome: "already_skipped", completed_at: null }] });
    expect((await complete(request(path, "PUT", body), occurrence)).status).toBe(409);

    answers({
      complete_chore_occurrence: [{ outcome: "invalid_contributor", completed_at: null }],
    });
    const contributor = await complete(request(path, "PUT", body), occurrence);
    expect(await contributor.json()).toEqual({ error: "invalid", fields: ["contributor"] });
  });

  it("refuses a missing contributor and an over-long note", async () => {
    const path = `/chore-occurrences/${OCCURRENCE}/completion`;
    for (const body of [{ note: null }, { contributor: MEMBER_A, note: "x".repeat(501) }]) {
      expect((await complete(request(path, "PUT", body), occurrence)).status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers not found for an id that is not a uuid", async () => {
    const response = await complete(
      request("/chore-occurrences/x/completion", "PUT", { contributor: MEMBER_A, note: null }),
      params("occurrenceId", "x"),
    );
    expect(response.status).toBe(404);
  });
});

describe("skip, reopen and steps", () => {
  it("skips with a reason and refuses a completed one", async () => {
    answers({ skip_chore_occurrence: [{ outcome: "skipped", revision: 4 }] });
    const path = `/chore-occurrences/${OCCURRENCE}/skip`;
    const response = await skip(request(path, "POST", { reason: " Away " }), occurrence);
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("skip_chore_occurrence", {
      p_occurrence_id: OCCURRENCE,
      p_reason: "Away",
    });
    answers({ skip_chore_occurrence: [{ outcome: "already_completed", revision: 4 }] });
    const refused = await skip(request(path, "POST", { reason: null }), occurrence);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "already-completed" });
    answers({ skip_chore_occurrence: [{ outcome: "not_permitted", revision: null }] });
    expect((await skip(request(path, "POST", { reason: null }), occurrence)).status).toBe(403);
  });

  it("reopens with an empty JSON body only", async () => {
    answers({ reopen_chore_occurrence: [{ outcome: "reopened", revision: 5 }] });
    const path = `/chore-occurrences/${OCCURRENCE}/reopen`;
    expect((await reopen(request(path, "POST", {}), occurrence)).status).toBe(200);
    expect((await reopen(request(path, "POST", { extra: 1 }), occurrence)).status).toBe(400);
    expect((await reopen(request(path, "POST", {}, crossSite), occurrence)).status).toBe(403);
  });

  it("ticks a step and answers the progress, or that the occurrence is closed", async () => {
    answers({ set_chore_step: [{ outcome: "saved", checked: true, done: 1, total: 2 }] });
    const path = `/chore-occurrences/${OCCURRENCE}/steps/${STEP}`;
    const context = { params: Promise.resolve({ occurrenceId: OCCURRENCE, stepId: STEP }) };
    const response = await tick(request(path, "PUT", { checked: true }), context);
    expect(await response.json()).toEqual({ checked: true, done: 1, total: 2 });
    answers({
      set_chore_step: [{ outcome: "occurrence_closed", checked: false, done: 0, total: 0 }],
    });
    const closed = await tick(request(path, "PUT", { checked: true }), {
      params: Promise.resolve({ occurrenceId: OCCURRENCE, stepId: STEP }),
    });
    expect(closed.status).toBe(409);
    expect(await closed.json()).toEqual({ error: "occurrence-closed" });
  });
});

describe("changing one occurrence", () => {
  it("sends only the parts given and asks to confirm removed ticked steps", async () => {
    const impact = { removed: 1, removedChecked: 1, added: 0, newlyMandatory: 0 };
    answers({ update_chore_occurrence: [{ outcome: "needs_confirmation", impact, revision: 2 }] });
    const response = await changeOccurrence(
      request(`/chore-occurrences/${OCCURRENCE}`, "PATCH", {
        expectedRevision: 2,
        dryRun: false,
        minutes: null,
        steps: [
          { id: STEP, label: "Sort", mandatory: true },
          { id: null, label: "Rinse", mandatory: false },
        ],
      }),
      occurrence,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "needs-confirmation", impact });
    expect(state.rpc).toHaveBeenCalledWith("update_chore_occurrence", {
      p_occurrence_id: OCCURRENCE,
      p_expected_revision: 2,
      p_dry_run: false,
      p_set_minutes: true,
      p_steps: [
        { id: STEP, label: "Sort", mandatory: true },
        { label: "Rinse", mandatory: false },
      ],
    });
  });

  it("refuses an empty change and answers a conflict with the revision", async () => {
    const path = `/chore-occurrences/${OCCURRENCE}`;
    expect(
      (
        await changeOccurrence(
          request(path, "PATCH", { expectedRevision: 2, dryRun: true }),
          occurrence,
        )
      ).status,
    ).toBe(400);
    answers({ update_chore_occurrence: [{ outcome: "conflict", impact: null, revision: 7 }] });
    const conflict = await changeOccurrence(
      request(path, "PATCH", { expectedRevision: 2, dryRun: false, dueDate: "2026-10-23" }),
      occurrence,
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "conflict", revision: 7 });
  });

  it("reads an occurrence, or not found when the database answers nothing", async () => {
    answers({ get_chore_occurrence: null });
    const response = await readOccurrence(
      request(`/chore-occurrences/${OCCURRENCE}`, "GET"),
      occurrence,
    );
    expect(response.status).toBe(404);
  });
});

describe("series, pause and delete", () => {
  it("sends a series change with its schedule and both revisions", async () => {
    const impact = { scope: "following", updated: 2, kept: 0, removed: 1 };
    // The database names a date's people `assignees`; the client reads `assigneeIds`.
    const next = [{ date: "2026-10-26", assignees: [MEMBER_B, null] }];
    answers({
      update_chore_series: [
        { outcome: "preview", impact: { ...impact, next }, revision: 4, occurrence_id: OCCURRENCE },
      ],
    });
    const response = await changeSeries(
      request(`/chore-occurrences/${OCCURRENCE}/series`, "POST", {
        scope: "following",
        expectedRevision: 2,
        expectedScheduleRevision: 4,
        dryRun: true,
        assignment: { mode: "fixed", members: [MEMBER_B] },
        schedule: { ...weekly, interval: 2 },
      }),
      occurrence,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: "preview",
      impact: { ...impact, next: [{ date: "2026-10-26", assigneeIds: [MEMBER_B, null] }] },
      occurrenceId: OCCURRENCE,
    });
    expect(state.rpc).toHaveBeenCalledWith("update_chore_series", {
      p_occurrence_id: OCCURRENCE,
      p_scope: "following",
      p_expected_revision: 2,
      p_expected_schedule_revision: 4,
      p_dry_run: true,
      p_assignment: { mode: "fixed", members: [MEMBER_B] },
      p_set_schedule: true,
      p_frequency: "weekly",
      p_interval: 2,
      p_starts_on: "2026-10-19",
      p_weekdays: [1, 6],
    });
  });

  it("refuses a series change without anything to change, or with this occurrence as scope", async () => {
    const path = `/chore-occurrences/${OCCURRENCE}/series`;
    const base = { expectedRevision: 2, expectedScheduleRevision: 4, dryRun: true };
    expect(
      (await changeSeries(request(path, "POST", { ...base, scope: "following" }), occurrence))
        .status,
    ).toBe(400);
    expect(
      (
        await changeSeries(
          request(path, "POST", { ...base, scope: "occurrence", minutes: 5 }),
          occurrence,
        )
      ).status,
    ).toBe(400);
  });

  it("pauses until a date and refuses an end date when resuming", async () => {
    answers({
      set_chore_paused: [
        {
          outcome: "saved",
          impact: { removed: 1, kept: 0, next: [{ date: "2026-11-02", assignees: [MEMBER_B] }] },
          revision: 5,
        },
      ],
    });
    const path = `/chores/${CHORE}/paused`;
    const chore = params("choreId", CHORE);
    const response = await pause(
      request(path, "PUT", {
        expectedScheduleRevision: 4,
        paused: true,
        until: "2026-11-01",
        dryRun: false,
      }),
      chore,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: "saved",
      impact: { removed: 1, kept: 0, next: [{ date: "2026-11-02", assigneeIds: [MEMBER_B] }] },
    });
    expect(state.rpc).toHaveBeenCalledWith("set_chore_paused", {
      p_chore_id: CHORE,
      p_expected_schedule_revision: 4,
      p_paused: true,
      p_until: "2026-11-01",
      p_dry_run: false,
    });
    expect(
      (
        await pause(
          request(path, "PUT", {
            expectedScheduleRevision: 4,
            paused: false,
            until: "2026-11-01",
            dryRun: false,
          }),
          params("choreId", CHORE),
        )
      ).status,
    ).toBe(400);
  });

  it("deletes with a scope and answers the trash entry", async () => {
    answers({
      delete_chore_occurrences: [
        {
          outcome: "deleted",
          impact: { scope: "series", removed: 2, kept: 3 },
          entry_id: ENTRY,
          revision: null,
        },
      ],
    });
    const response = await removeOccurrences(
      request(`/chore-occurrences/${OCCURRENCE}/delete`, "POST", {
        scope: "series",
        expectedRevision: 2,
        dryRun: false,
      }),
      occurrence,
    );
    expect(await response.json()).toEqual({
      outcome: "deleted",
      impact: { scope: "series", removed: 2, kept: 3 },
      entryId: ENTRY,
    });
    answers({
      delete_chore_occurrences: [
        { outcome: "scope_unavailable", impact: null, entry_id: null, revision: null },
      ],
    });
    const refused = await removeOccurrences(
      request(`/chore-occurrences/${OCCURRENCE}/delete`, "POST", {
        scope: "following",
        expectedRevision: 2,
        dryRun: true,
      }),
      occurrence,
    );
    expect(refused.status).toBe(409);
  });
});

describe("chore fields, reads and categories", () => {
  it("changes the chore's own fields", async () => {
    answers({ update_chore: [{ outcome: "saved", revision: 3 }] });
    const response = await patchChore(
      request(`/chores/${CHORE}`, "PATCH", {
        expectedRevision: 2,
        title: "Bins",
        instructions: "Rinse first",
        categoryId: null,
      }),
      params("choreId", CHORE),
    );
    expect(await response.json()).toEqual({ outcome: "saved", revision: 3 });
    expect(state.rpc).toHaveBeenCalledWith("update_chore", {
      p_chore_id: CHORE,
      p_expected_revision: 2,
      p_title: "Bins",
      p_instructions: "Rinse first",
    });
  });

  it("creates occurrences that are due before listing them", async () => {
    answers({ advance_chores: 0, list_chore_occurrences: [] });
    const response = await listOccurrences(
      request(
        `/chore-occurrences?homeId=${HOME}&assignee=member&member=${MEMBER_A}&category=none`,
        "GET",
      ),
    );
    expect(response.status).toBe(200);
    expect(state.rpc.mock.calls.map(([name]) => name)).toEqual([
      "advance_chores",
      "list_chore_occurrences",
    ]);
    expect(state.rpc.mock.calls[1]?.[1]).toMatchObject({
      p_home_id: HOME,
      p_assignee: "member",
      p_member: MEMBER_A,
      p_category: "none",
    });
  });

  it("answers not found for history the person may not see, and refuses an unknown filter", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "22023", message: "invalid request" } });
    const chore = () => params("choreId", CHORE);
    expect((await history(request(`/chores/${CHORE}/history`, "GET"), chore())).status).toBe(404);
    expect(
      (await history(request(`/chores/${CHORE}/history?filter=late`, "GET"), chore())).status,
    ).toBe(400);
  });

  it("lists active or ended chores of a Home", async () => {
    answers({ list_chores: [] });
    expect((await listChores(request(`/chores?homeId=${HOME}&ended=true`, "GET"))).status).toBe(
      200,
    );
    expect(state.rpc).toHaveBeenCalledWith("list_chores", { p_home_id: HOME, p_ended: true });
    expect((await listChores(request("/chores", "GET"))).status).toBe(400);
  });

  it("creates, changes, orders and deletes categories", async () => {
    answers({ create_chore_category: [{ outcome: "duplicate_name", revision: null }] });
    const duplicate = await createCategory(
      request("/chore-categories", "POST", {
        id: CATEGORY,
        homeId: HOME,
        name: "Kitchen",
        color: "teal",
      }),
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "duplicate-name" });

    expect(
      (
        await createCategory(
          request("/chore-categories", "POST", {
            id: CATEGORY,
            homeId: HOME,
            name: "K",
            color: "plaid",
          }),
        )
      ).status,
    ).toBe(400);

    answers({ update_chore_category: [{ outcome: "saved", revision: 2 }] });
    const saved = await patchCategory(
      request(`/chore-categories/${CATEGORY}`, "PATCH", {
        expectedRevision: 1,
        name: "Kitchen",
        color: "teal",
        archived: true,
      }),
      params("categoryId", CATEGORY),
    );
    expect(saved.status).toBe(200);

    answers({ reorder_chore_categories: "saved" });
    expect(
      (
        await orderCategories(
          request("/chore-categories", "PUT", { homeId: HOME, ids: [CATEGORY] }),
        )
      ).status,
    ).toBe(200);

    answers({ delete_chore_category: [{ outcome: "preview", chore_count: 4, revision: 2 }] });
    const preview = await deleteCategory(
      request(`/chore-categories/${CATEGORY}/delete`, "POST", {
        expectedRevision: 2,
        dryRun: true,
      }),
      params("categoryId", CATEGORY),
    );
    expect(await preview.json()).toEqual({ outcome: "preview", choreCount: 4 });
  });
});

describe("approval", () => {
  it("submits a completion of a chore that requires approval", async () => {
    answers({
      complete_chore_occurrence: [
        {
          outcome: "submitted",
          completed_at: "2026-10-21T09:00:00Z",
          completed_by_me: true,
          completed_by_member: MEMBER_A,
          contributor_me: false,
          contributor_member: MEMBER_B,
          open_mandatory: 0,
          revision: 3,
        },
      ],
    });
    const response = await complete(
      request(`/chore-occurrences/${OCCURRENCE}/completion`, "PUT", {
        contributor: MEMBER_B,
        note: null,
      }),
      occurrence,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "submitted" });
  });

  it("rejects with a normalized reason and refuses a rejection without one", async () => {
    answers({ review_chore_submission: [{ outcome: "rejected", status: "open", revision: 4 }] });
    const response = await review(
      request(`/chore-occurrences/${OCCURRENCE}/review`, "POST", {
        expectedRevision: 3,
        decision: "reject",
        reason: "  Glass\n left ",
      }),
      occurrence,
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("review_chore_submission", {
      p_occurrence_id: OCCURRENCE,
      p_expected_revision: 3,
      p_decision: "reject",
      p_reason: "Glass left",
    });
    for (const body of [
      { expectedRevision: 3, decision: "reject", reason: "   " },
      { expectedRevision: 3, decision: "approve", reason: "Fine" },
      { expectedRevision: 3, decision: "maybe", reason: null },
    ]) {
      const refused = await review(
        request(`/chore-occurrences/${OCCURRENCE}/review`, "POST", body),
        occurrence,
      );
      expect(refused.status).toBe(400);
    }
  });

  it("answers stale, decided, not permitted and departed-contributor decisions", async () => {
    const cases = [
      [{ outcome: "conflict", status: "pending_approval", revision: 5 }, 409, "conflict"],
      [{ outcome: "not_pending", status: "completed", revision: 5 }, 409, "not-pending"],
      [{ outcome: "not_permitted", status: null, revision: null }, 403, "not-permitted"],
      [
        { outcome: "contributor_unavailable", status: "pending_approval", revision: 3 },
        409,
        "contributor-unavailable",
      ],
    ] as const;
    for (const [row, status, error] of cases) {
      answers({ review_chore_submission: [row] });
      const response = await review(
        request(`/chore-occurrences/${OCCURRENCE}/review`, "POST", {
          expectedRevision: 3,
          decision: "approve",
          reason: null,
        }),
        occurrence,
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error });
    }
  });

  it("refuses a cross-site decision before reading it", async () => {
    const response = await review(
      request(
        `/chore-occurrences/${OCCURRENCE}/review`,
        "POST",
        { expectedRevision: 3, decision: "approve", reason: null },
        crossSite,
      ),
      occurrence,
    );
    expect(response.status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("corrects only the parts given, clearing the note when asked", async () => {
    answers({ correct_chore_completion: [{ outcome: "corrected", revision: 6 }] });
    const response = await correct(
      request(`/chore-occurrences/${OCCURRENCE}/completion-record`, "PUT", {
        expectedRevision: 5,
        contributor: MEMBER_B,
        note: null,
        reason: null,
      }),
      occurrence,
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("correct_chore_completion", {
      p_occurrence_id: OCCURRENCE,
      p_expected_revision: 5,
      p_contributor: MEMBER_B,
      p_set_note: true,
    });
    answers({ correct_chore_completion: [{ outcome: "not_completed", revision: 6 }] });
    const closed = await correct(
      request(`/chore-occurrences/${OCCURRENCE}/completion-record`, "PUT", { expectedRevision: 5 }),
      occurrence,
    );
    expect(closed.status).toBe(409);
    expect(await closed.json()).toEqual({ error: "not-completed", revision: 6 });
    const future = await correct(
      request(`/chore-occurrences/${OCCURRENCE}/completion-record`, "PUT", {
        expectedRevision: 5,
        completedAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
      occurrence,
    );
    expect(future.status).toBe(400);
  });

  it("lists the review queue, or not found for a Home the person is not in", async () => {
    answers({ list_chore_approvals: [] });
    const response = await listApprovals(request(`/chore-approvals?homeId=${HOME}`, "GET"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ approvals: [] });
    state.rpc.mockImplementation(() => ({
      data: null,
      error: { code: "42501", message: "not permitted" },
    }));
    const hidden = await listApprovals(request(`/chore-approvals?homeId=${HOME}`, "GET"));
    expect(hidden.status).toBe(404);
  });
});

describe("templates", () => {
  const template = {
    id: TEMPLATE,
    homeId: HOME,
    title: " Bathroom ",
    instructions: null,
    categoryId: null,
    minutes: 30,
    steps: [{ label: "Mirror", mandatory: false }],
  };

  it("creates one with only the fields it has", async () => {
    answers({ create_chore_template: [{ outcome: "created", revision: 1 }] });
    const response = await createTemplate(request("/chore-templates", "POST", template));
    expect(response.status).toBe(201);
    expect(state.rpc).toHaveBeenCalledWith("create_chore_template", {
      p_id: TEMPLATE,
      p_home_id: HOME,
      p_title: "Bathroom",
      p_minutes: 30,
      p_steps: [{ label: "Mirror", mandatory: false }],
      p_points: 0,
      p_late_policy: "full",
    });
  });

  it("refuses a cross-site request and maps a taken name", async () => {
    expect(
      (await createTemplate(request("/chore-templates", "POST", template, crossSite))).status,
    ).toBe(403);
    answers({ create_chore_template: [{ outcome: "duplicate_name", revision: null }] });
    const response = await createTemplate(request("/chore-templates", "POST", template));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "duplicate-name" });
  });

  it("retires one with the revision seen, and reports a conflict", async () => {
    answers({ update_chore_template: [{ outcome: "conflict", revision: 4 }] });
    const response = await patchTemplate(
      request(`/chore-templates/${TEMPLATE}`, "PATCH", {
        expectedRevision: 3,
        title: "Bathroom",
        instructions: null,
        categoryId: CATEGORY,
        minutes: null,
        steps: [],
        retired: true,
      }),
      params("templateId", TEMPLATE),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict", revision: 4 });
    expect(state.rpc).toHaveBeenCalledWith("update_chore_template", {
      p_id: TEMPLATE,
      p_expected_revision: 3,
      p_title: "Bathroom",
      p_category_id: CATEGORY,
      p_steps: [],
      p_retired: true,
    });
  });

  it("lists them, checking the checklist's shape", async () => {
    answers({
      list_chore_templates: [
        {
          id: TEMPLATE,
          title: "Bathroom",
          instructions: null,
          category_id: CATEGORY,
          category_name: "Wet rooms",
          category_color: "teal",
          category_archived: true,
          minutes: null,
          steps: [{ label: "Mirror", mandatory: true }],
          retired: false,
          revision: 2,
          points: 8,
          late_policy: "reduced",
          late_points: 3,
        },
      ],
    });
    const response = await listTemplates(
      request(`/chore-templates?homeId=${HOME}&retired=true`, "GET"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      templates: [
        {
          id: TEMPLATE,
          title: "Bathroom",
          instructions: null,
          category: { id: CATEGORY, name: "Wet rooms", color: "teal", archived: true },
          minutes: null,
          steps: [{ label: "Mirror", mandatory: true }],
          retired: false,
          revision: 2,
          points: { points: 8, latePolicy: "reduced", latePoints: 3 },
        },
      ],
    });
    expect(state.rpc).toHaveBeenCalledWith("list_chore_templates", {
      p_home_id: HOME,
      p_include_retired: true,
    });
  });
});

describe("Home-wide history", () => {
  it("sends the search and filters, falling back for unknown values", async () => {
    answers({ list_home_chore_history: [] });
    const response = await homeHistory(
      request(
        `/chore-history?homeId=${HOME}&q=%20100%25%20%20soap&member=${MEMBER_A}&from=2026-10-10&to=2026-10-01&basis=completed&state=bogus&approval=rejected&offset=50`,
        "GET",
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 0, offset: 50, rows: [] });
    expect(state.rpc).toHaveBeenCalledWith("list_home_chore_history", {
      p_home_id: HOME,
      p_search: "100% soap",
      p_member: MEMBER_A,
      p_from: "2026-10-10",
      p_basis: "completed",
      p_state: "all",
      p_approval: "rejected",
      p_offset: 50,
      p_limit: 50,
    });
  });

  it("is not found for a Home the person is not in, and needs a session", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not permitted" } });
    expect((await homeHistory(request(`/chore-history?homeId=${HOME}`, "GET"))).status).toBe(404);
    state.identity = null;
    expect((await homeHistory(request(`/chore-history?homeId=${HOME}`, "GET"))).status).toBe(401);
  });
});

describe("bulk changes", () => {
  const items = [
    { id: OCCURRENCE, revision: 2 },
    { id: OTHER, revision: 5 },
  ];
  const row = (id: string, outcome: string) => ({
    occurrence_id: id,
    outcome,
    title: "Bins",
    due_before: "2026-10-21",
    due_after: outcome === "saved" ? "2026-10-25" : null,
    assignees_before: [MEMBER_A],
    assignees_after: outcome === "saved" ? [MEMBER_A] : null,
    revision: 3,
  });

  it("answers each item's own result, applied or not", async () => {
    answers({ bulk_chore_occurrences: [row(OCCURRENCE, "saved"), row(OTHER, "pending_approval")] });
    const response = await bulk(
      request("/chore-occurrences/bulk", "POST", {
        homeId: HOME,
        action: "due_date",
        items,
        dryRun: false,
        dueDate: "2026-10-25",
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: { outcome: string }[] };
    expect(body.results.map((result) => result.outcome)).toEqual(["saved", "pending_approval"]);
    expect(state.rpc).toHaveBeenCalledWith("bulk_chore_occurrences", {
      p_home_id: HOME,
      p_action: "due_date",
      p_items: items,
      p_dry_run: false,
      p_due_date: "2026-10-25",
    });
  });

  it("needs the value its action uses, and nothing else", async () => {
    for (const body of [
      { homeId: HOME, action: "reassign", items, dryRun: true },
      { homeId: HOME, action: "skip", items, dryRun: true, member: MEMBER_A },
      { homeId: HOME, action: "due_date", items, dryRun: true, dueDate: "2026-10-25", reason: "x" },
      { homeId: HOME, action: "skip", items: [], dryRun: true },
      { homeId: HOME, action: "skip", items: [items[0], items[0]], dryRun: true },
    ]) {
      expect((await bulk(request("/chore-occurrences/bulk", "POST", body))).status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("reports an unknown outcome as failed rather than passing it on", async () => {
    answers({ bulk_chore_occurrences: [row(OCCURRENCE, "surprise")] });
    const response = await bulk(
      request("/chore-occurrences/bulk", "POST", {
        homeId: HOME,
        action: "skip",
        items: [items[0]],
        dryRun: true,
        reason: "  Away  ",
      }),
    );
    const body = (await response.json()) as { results: { outcome: string }[] };
    expect(body.results[0]?.outcome).toBe("failed");
    expect(state.rpc).toHaveBeenCalledWith(
      "bulk_chore_occurrences",
      expect.objectContaining({ p_reason: "Away", p_action: "skip" }),
    );
  });
});
