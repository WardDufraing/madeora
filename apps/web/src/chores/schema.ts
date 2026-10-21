import { z } from "zod";

import { nameProblem, normalizeName } from "@/names/visible-name";
import { weekStarts } from "@/preferences/schema";
import {
  clockTimeSchema,
  dateOnlySchema,
  isLabelColor,
  type LabelColor,
  localDateTimeSchema,
  plainTextSchema,
  recurrenceSchema,
} from "@/tasks/schema";

/**
 * The chores contract (S20, versioned for later mobile clients). Client-safe. Every limit matches the
 * database (`private.chore_limit` in supabase/migrations/*_chores.sql), which checks everything
 * again. Recurring chores use the S19 schedule (`recurrenceSchema`) unchanged.
 */
export const CHORE_LIMITS = {
  /** S21 (`private.chore_pool_limit`). */
  pool: 200,
  requestNote: 200,
  autoReleaseHours: 720,
  /** S21 proposals and volunteer requests (`private.chore_volunteer_limit`). */
  proposalDays: 365,
  recipients: 20,
  title: 200,
  instructions: 2000,
  categoryName: 40,
  categories: 50,
  steps: 30,
  stepLabel: 120,
  members: 20,
  minutes: 1440,
  note: 500,
  reason: 500,
  page: 100,
  historyPage: 50,
  maxOffset: 10000,
  horizon: 7,
  previewDates: 5,
  approvalsPage: 100,
  templates: 100,
  search: 100,
  bulkItems: 100,
  widgetRows: 20,
} as const;

/** Field error codes the forms translate. */
export type ChoreFieldError =
  "required" | "tooLong" | "invalidCharacters" | "duplicate" | "invalid";

const id = z.uuid();

/** A name others see (chore titles, category names, step labels), as the database stores it. */
function nameSchema(max: number) {
  return z
    .string({ error: "required" satisfies ChoreFieldError })
    .max(4 * max, { error: "tooLong" satisfies ChoreFieldError })
    .transform((value, context) => {
      const name = normalizeName(value);
      if (name === "") {
        context.addIssue({ code: "custom", message: "required" satisfies ChoreFieldError });
        return z.NEVER;
      }
      const problem = nameProblem(name, max);
      if (problem) {
        context.addIssue({
          code: "custom",
          message: (problem === "tooLong"
            ? "tooLong"
            : "invalidCharacters") satisfies ChoreFieldError,
        });
        return z.NEVER;
      }
      return name;
    });
}

export const choreTitleSchema = nameSchema(CHORE_LIMITS.title);
export const categoryNameSchema = nameSchema(CHORE_LIMITS.categoryName);
export const stepLabelSchema = nameSchema(CHORE_LIMITS.stepLabel);

/** Optional instructions: empty (or only whitespace) means none. */
export const instructionsSchema = z
  .string()
  .transform((value) => (value.trim() === "" ? null : value))
  .pipe(plainTextSchema(CHORE_LIMITS.instructions).nullable());

/**
 * Whitespace as the database reads a short note or reason: trimmed, every run (line breaks too) one
 * space. Empty is no text.
 */
export function normalizeShortText(value: string): string | null {
  const text = value.replace(/\s+/gu, " ").trim();
  return text === "" ? null : text;
}

function shortTextSchema(max: number) {
  return z
    .string()
    .max(8 * max, "tooLong")
    .transform(normalizeShortText)
    .pipe(plainTextSchema(max).nullable());
}

export const noteSchema = shortTextSchema(CHORE_LIMITS.note);
export const reasonSchema = shortTextSchema(CHORE_LIMITS.reason);

export const minutesSchema = z.int().min(1).max(CHORE_LIMITS.minutes);

/** How two labels compare when looking for confusing duplicates (as `private.task_name_key`). */
export function labelKey(label: string): string {
  return label.normalize("NFKC").replace(/\s+/gu, " ").toLowerCase();
}

const stepSchema = z.strictObject({ label: stepLabelSchema, mandatory: z.boolean() });

function noDuplicateLabels(steps: readonly { readonly label: string }[]): boolean {
  return new Set(steps.map((step) => labelKey(step.label))).size === steps.length;
}

/** A checklist template: ordered steps, no two that read alike. */
export const stepsSchema = z
  .array(stepSchema)
  .max(CHORE_LIMITS.steps)
  .refine(noDuplicateLabels, { message: "duplicate" });
export type StepInput = z.output<typeof stepSchema>;

/** One occurrence's own checklist: a step with an id keeps its progress. */
export const occurrenceStepsSchema = z
  .array(stepSchema.extend({ id: id.nullable() }))
  .max(CHORE_LIMITS.steps)
  .refine(noDuplicateLabels, { message: "duplicate" })
  .refine(
    (steps) => {
      const ids = steps.flatMap((step) => (step.id === null ? [] : [step.id]));
      return new Set(ids).size === ids.length;
    },
    { message: "invalid" },
  );

export const assignmentModes = ["none", "fixed", "rotating"] as const;
export type AssignmentMode = (typeof assignmentModes)[number];

/**
 * Who a chore is for: nobody in particular, fixed members (1–20), or a rotation order (2–20,
 * recurring chores only). Members are membership ids, in order.
 */
export const assignmentSchema = z
  .strictObject({
    mode: z.enum(assignmentModes),
    members: z.array(id).max(CHORE_LIMITS.members),
  })
  .refine((value) => new Set(value.members).size === value.members.length, {
    message: "duplicate",
    path: ["members"],
  })
  .refine(
    (value) =>
      value.mode === "none"
        ? value.members.length === 0
        : value.members.length >= (value.mode === "rotating" ? 2 : 1),
    { message: "required", path: ["members"] },
  );
export type AssignmentInput = z.output<typeof assignmentSchema>;

export const createChoreSchema = z
  .strictObject({
    id,
    homeId: id,
    title: choreTitleSchema,
    instructions: instructionsSchema.nullable(),
    categoryId: id.nullable(),
    minutes: minutesSchema.nullable(),
    steps: stepsSchema,
    assignment: assignmentSchema,
    /** A one-off chore's date; null for a recurring chore. */
    dueDate: dateOnlySchema.nullable(),
    recurrence: recurrenceSchema.nullable(),
    /** Completions wait for a reviewer's approval. */
    requiresApproval: z.boolean().default(false),
  })
  .refine((chore) => (chore.recurrence === null) !== (chore.dueDate === null), {
    message: "required",
    path: ["dueDate"],
  })
  .refine((chore) => chore.recurrence !== null || chore.assignment.mode !== "rotating", {
    message: "invalid",
    path: ["assignment"],
  });
export type CreateChoreInput = z.output<typeof createChoreSchema>;

export const updateChoreSchema = z.strictObject({
  expectedRevision: z.int().min(1),
  title: choreTitleSchema,
  instructions: instructionsSchema.nullable(),
  categoryId: id.nullable(),
  /** Left out: unchanged. */
  requiresApproval: z.boolean().optional(),
});

export const completionSchema = z.strictObject({
  /** The membership id of who actually did the work. */
  contributor: id,
  note: noteSchema.nullable(),
});

export const skipSchema = z.strictObject({ reason: reasonSchema.nullable() });

/** A reviewer's decision on the pending submission: a rejection needs a reason, approval none. */
export const reviewSchema = z
  .strictObject({
    expectedRevision: z.int().min(1),
    decision: z.enum(["approve", "reject"]),
    reason: reasonSchema.nullable(),
  })
  .refine((review) => (review.decision === "reject") === (review.reason !== null), {
    message: "required",
    path: ["reason"],
  });

/** A correction of a completed record; each part optional (null or left out keeps it). */
export const correctionSchema = z
  .strictObject({
    expectedRevision: z.int().min(1),
    contributor: id.nullable().optional(),
    completedAt: z.iso.datetime({ offset: true }).nullable().optional(),
    /** Present: the note becomes this (null clears it). */
    note: noteSchema.nullable().optional(),
    reason: reasonSchema.nullable().optional(),
  })
  .refine(
    (correction) =>
      correction.completedAt == null || Date.parse(correction.completedAt) <= Date.now() + 300_000,
    { message: "invalid", path: ["completedAt"] },
  );
export const stepCheckSchema = z.strictObject({ checked: z.boolean() });

/** Claiming takes no fields; a release says whether it is the Undo right after claiming. */
export const claimSchema = z.strictObject({});
export const releaseSchema = z.strictObject({ undo: z.boolean().default(false) });

export const claimModes = ["all", "selected", "none"] as const;
export const expiryPolicies = ["overdue", "week_end"] as const;

/** Who may claim a chore, whether it closes after its week, its automatic release (S21). */
export const claimPolicySchema = z
  .strictObject({
    expectedRevision: z.int().min(1),
    mode: z.enum(claimModes),
    memberIds: z.array(id).max(CHORE_LIMITS.members),
    expiry: z.enum(expiryPolicies),
    /** Hours after the end of the due day; null: never released automatically. */
    autoReleaseHours: z.int().min(0).max(CHORE_LIMITS.autoReleaseHours).nullable(),
    dryRun: z.boolean(),
    confirm: z.boolean().default(false),
  })
  .refine((policy) => (policy.mode === "selected") === policy.memberIds.length > 0, {
    message: "required",
    path: ["memberIds"],
  });

export const choreSettingsSchema = z.strictObject({
  homeId: id,
  expectedRevision: z.int().min(0),
  weekStart: z.enum(weekStarts),
  reassignmentConfirmation: z.boolean(),
});

export const reassignmentRequestSchema = z.strictObject({
  id,
  toMember: id,
  note: shortTextSchema(CHORE_LIMITS.requestNote).nullable(),
  /** The assignee whose part is handed over; only chore managers may name someone else. */
  fromMember: id.optional(),
});

export const reassignmentStatuses = [
  "pending",
  "awaiting_manager",
  "accepted",
  "declined",
  "cancelled",
  "invalidated",
  "refused",
] as const;

export const reassignmentActions = ["accept", "decline", "cancel", "confirm", "refuse"] as const;
export const reassignmentAnswerSchema = z.strictObject({
  action: z.enum(reassignmentActions),
});

/** A reason that must be given (a rejection, a correction). */
const requiredReasonSchema = reasonSchema.refine((value) => value !== null, {
  message: "required",
});

/** A proposed chore's fields (S21): the same as a one-off unassigned chore's. */
const proposalFields = {
  title: choreTitleSchema,
  instructions: instructionsSchema.nullable(),
  categoryId: id.nullable(),
  minutes: minutesSchema.nullable(),
  steps: stepsSchema,
  dueDate: dateOnlySchema,
};
export const proposalSchema = z.strictObject({ id, homeId: id, ...proposalFields });
export type ProposalInput = z.output<typeof proposalSchema>;

/** A decision on a proposal: withdraw (its proposer), reject with a reason or approve the final fields. */
export const proposalDecisionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("withdraw"), expectedRevision: z.int().min(1) }),
  z.strictObject({
    action: z.literal("reject"),
    expectedRevision: z.int().min(1),
    reason: requiredReasonSchema,
  }),
  z.strictObject({
    action: z.literal("approve"),
    expectedRevision: z.int().min(1),
    ...proposalFields,
  }),
]);
export type ProposalDecisionInput = z.output<typeof proposalDecisionSchema>;

const recipientsSchema = z
  .array(id)
  .min(1)
  .max(CHORE_LIMITS.recipients)
  .refine((ids) => new Set(ids).size === ids.length, { message: "duplicate" });

export const volunteerRequestSchema = z.strictObject({
  id,
  expectedRevision: z.int().min(1),
  memberIds: recipientsSchema,
  dryRun: z.boolean().default(false),
});

/** An invitee's answer, or a chore manager's change to an open request. */
export const volunteerChangeSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.enum(["accept", "decline", "cancel"]) }),
  z.strictObject({ action: z.enum(["withdraw", "add"]), memberIds: recipientsSchema }),
]);
export type VolunteerChangeInput = z.output<typeof volunteerChangeSchema>;

export const volunteerCorrectionSchema = z.strictObject({
  expectedRevision: z.int().min(1),
  reason: requiredReasonSchema,
  /** The new assignee's membership id; null returns the occurrence to Needs assignment review. */
  memberId: id.nullable(),
  dryRun: z.boolean().default(false),
});

/** A change to this occurrence only; each part optional, at least one given. */
export const occurrenceChangeSchema = z
  .strictObject({
    expectedRevision: z.int().min(1),
    dryRun: z.boolean(),
    dueDate: dateOnlySchema.optional(),
    assigneeIds: z.array(id).max(CHORE_LIMITS.members).optional(),
    /** A number sets the estimate, null clears it. */
    minutes: minutesSchema.nullable().optional(),
    steps: occurrenceStepsSchema.optional(),
    confirmChecklist: z.boolean().optional(),
    /** Confirms a new due date that releases a claim at once (S21). */
    confirmRelease: z.boolean().optional(),
  })
  .refine(
    (change) =>
      change.dueDate !== undefined ||
      change.assigneeIds !== undefined ||
      change.minutes !== undefined ||
      change.steps !== undefined,
    { message: "required", path: ["dueDate"] },
  );
export type OccurrenceChangeInput = z.output<typeof occurrenceChangeSchema>;

export const choreScopes = ["following", "series"] as const;
export type ChoreScope = (typeof choreScopes)[number];

/** A change to this and following occurrences, or the entire series; at least one part. */
export const seriesChangeSchema = z
  .strictObject({
    scope: z.enum(choreScopes),
    expectedRevision: z.int().min(1),
    expectedScheduleRevision: z.int().min(1),
    dryRun: z.boolean(),
    assignment: assignmentSchema.optional(),
    steps: stepsSchema.optional(),
    minutes: minutesSchema.nullable().optional(),
    schedule: recurrenceSchema.optional(),
  })
  .refine(
    (change) =>
      change.assignment !== undefined ||
      change.steps !== undefined ||
      change.minutes !== undefined ||
      change.schedule !== undefined,
    { message: "required", path: ["assignment"] },
  );
export type SeriesChangeInput = z.output<typeof seriesChangeSchema>;

export const deleteScopes = ["occurrence", "following", "series"] as const;
export type DeleteScope = (typeof deleteScopes)[number];

export const deleteSchema = z.strictObject({
  scope: z.enum(deleteScopes),
  expectedRevision: z.int().min(1),
  dryRun: z.boolean(),
});

export const pausedSchema = z
  .strictObject({
    expectedScheduleRevision: z.int().min(1),
    paused: z.boolean(),
    /** The last paused day (inclusive); null pauses until resumed. */
    until: dateOnlySchema.nullable(),
    dryRun: z.boolean(),
  })
  .refine((value) => value.paused || value.until === null, { message: "invalid", path: ["until"] });

const categoryColorSchema = z.custom<LabelColor>(isLabelColor, "invalid");

export const createCategorySchema = z.strictObject({
  id,
  homeId: id,
  name: categoryNameSchema,
  color: categoryColorSchema,
});
export const updateCategorySchema = z.strictObject({
  expectedRevision: z.int().min(1),
  name: categoryNameSchema,
  color: categoryColorSchema,
  archived: z.boolean(),
});
export const deleteCategorySchema = z.strictObject({
  expectedRevision: z.int().min(1),
  dryRun: z.boolean(),
});
export const reorderCategoriesSchema = z.strictObject({
  homeId: id,
  ids: z.array(id).min(1).max(CHORE_LIMITS.categories),
});

/** A chore template (S20): the fields a new chore copies, never assignees, schedule or history. */
const templateFields = {
  title: choreTitleSchema,
  instructions: instructionsSchema.nullable(),
  categoryId: id.nullable(),
  minutes: minutesSchema.nullable(),
  steps: stepsSchema,
};
export const createTemplateSchema = z.strictObject({ id, homeId: id, ...templateFields });
export type CreateTemplateInput = z.output<typeof createTemplateSchema>;
export const updateTemplateSchema = z.strictObject({
  expectedRevision: z.int().min(1),
  ...templateFields,
  /** Retire (true) or reinstate (false); left out: unchanged. */
  retired: z.boolean().optional(),
});

export const historyFilters = [
  "all",
  "completed",
  "skipped",
  "missed",
  "pending_approval",
  "rework",
] as const;
export type HistoryFilter = (typeof historyFilters)[number];

export const assigneeFilters = ["any", "me", "member", "unassigned"] as const;
export type ChoreAssigneeFilter = (typeof assigneeFilters)[number];

/** The overview's filters from the address bar; anything unknown falls back to the default. */
export const overviewQuerySchema = z.object({
  assignee: z.enum(assigneeFilters).catch("any"),
  member: id.optional().catch(undefined),
  category: z
    .union([z.literal("any"), z.literal("none"), id])
    .catch("any")
    .default("any"),
});
export type OverviewQuery = z.output<typeof overviewQuerySchema>;

export const homeHistoryStates = [
  "all",
  "open",
  "due_today",
  "missed",
  "rework",
  "pending_approval",
  "completed",
  "skipped",
] as const;
export type HomeHistoryState = (typeof homeHistoryStates)[number];
export const homeHistoryApprovals = ["any", "pending", "approved", "rejected", "none"] as const;
export type HomeHistoryApproval = (typeof homeHistoryApprovals)[number];
export const homeHistoryBases = ["scheduled", "completed"] as const;
export type HomeHistoryBasis = (typeof homeHistoryBases)[number];

/**
 * The Home-wide history's search and filters (spec "Confirmed searchable Home-wide chore completion
 * history"), from the address bar or the API's query string. Anything unknown falls back to its
 * default, so an old or edited link still opens; a range that ends before it starts drops its end.
 */
export const homeHistoryQuerySchema = z
  .object({
    // At most 100 characters: a longer search is cut there, never refused.
    q: z
      .string()
      .transform((value) => (normalizeShortText(value) ?? "").slice(0, CHORE_LIMITS.search).trim())
      .catch(""),
    member: id.optional().catch(undefined),
    chore: id.optional().catch(undefined),
    from: dateOnlySchema.optional().catch(undefined),
    to: dateOnlySchema.optional().catch(undefined),
    basis: z.enum(homeHistoryBases).catch("scheduled"),
    state: z.enum(homeHistoryStates).catch("all"),
    approval: z.enum(homeHistoryApprovals).catch("any"),
  })
  .transform((query) =>
    query.from !== undefined && query.to !== undefined && query.to < query.from
      ? { ...query, to: undefined }
      : query,
  );
export type HomeHistoryQuery = z.output<typeof homeHistoryQuerySchema>;

export function parseHomeHistoryQuery(
  params: Record<string, string | string[] | undefined>,
): HomeHistoryQuery {
  return homeHistoryQuerySchema.parse({
    q: firstParam(params.q) ?? "",
    member: firstParam(params.member),
    chore: firstParam(params.chore),
    from: firstParam(params.from),
    to: firstParam(params.to),
    basis: firstParam(params.basis),
    state: firstParam(params.state),
    approval: firstParam(params.approval),
  });
}

/** True when nothing narrows the history. */
export function isDefaultHistoryQuery(query: HomeHistoryQuery): boolean {
  return (
    query.q === "" &&
    query.member === undefined &&
    query.chore === undefined &&
    query.from === undefined &&
    query.to === undefined &&
    query.basis === "scheduled" &&
    query.state === "all" &&
    query.approval === "any"
  );
}

/** The query string for a history query: defaults left out. */
export function homeHistorySearch(query: HomeHistoryQuery): string {
  const params = new URLSearchParams();
  if (query.q !== "") params.set("q", query.q);
  if (query.member) params.set("member", query.member);
  if (query.chore) params.set("chore", query.chore);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.basis !== "scheduled") params.set("basis", query.basis);
  if (query.state !== "all") params.set("state", query.state);
  if (query.approval !== "any") params.set("approval", query.approval);
  return params.toString();
}

export const bulkActions = ["reassign", "skip", "due_date"] as const;
export type BulkAction = (typeof bulkActions)[number];

/**
 * A bulk change of selected occurrences (S20, chore managers; spec "Confirmed limited bulk chore
 * occurrence management"): each with the revision the manager saw, a preview first (`dryRun`).
 */
export const bulkSchema = z
  .strictObject({
    homeId: id,
    action: z.enum(bulkActions),
    items: z
      .array(z.strictObject({ id, revision: z.int().min(1) }))
      .min(1)
      .max(CHORE_LIMITS.bulkItems)
      .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
        message: "duplicate",
      }),
    dryRun: z.boolean(),
    member: id.nullable().default(null),
    dueDate: dateOnlySchema.nullable().default(null),
    reason: reasonSchema.nullable().default(null),
  })
  .refine((bulk) => (bulk.action === "reassign") === (bulk.member !== null), {
    message: "required",
    path: ["member"],
  })
  .refine((bulk) => (bulk.action === "due_date") === (bulk.dueDate !== null), {
    message: "required",
    path: ["dueDate"],
  })
  .refine((bulk) => bulk.action === "skip" || bulk.reason === null, {
    message: "invalid",
    path: ["reason"],
  });
export type BulkInput = z.output<typeof bulkSchema>;

/** Reads one value of a search parameter (the first, when repeated). */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The pool's week (S21): any day of it from `?poolWeek=`, or null for the current week. */
export function parsePoolWeek(
  params: Record<string, string | string[] | undefined>,
): string | null {
  const date = dateOnlySchema.safeParse(firstParam(params.poolWeek));
  return date.success ? date.data : null;
}

export function parseOverviewQuery(
  params: Record<string, string | string[] | undefined>,
): OverviewQuery {
  // The filter form sends a member's id as the assignee itself.
  const assignee = firstParam(params.assignee);
  const memberChosen = id.safeParse(assignee).success;
  const query = overviewQuerySchema.parse({
    assignee: memberChosen ? "member" : assignee,
    member: memberChosen ? assignee : firstParam(params.member),
    category: firstParam(params.category),
  });
  // "member" needs a member; without one it reads as anyone.
  if (query.assignee === "member" && query.member === undefined) {
    return { ...query, assignee: "any" };
  }
  return query;
}

/** S21: personal reminders, the schedule range and the manager summary (`private.chore_schedule_limit`). */
export const CHORE_SCHEDULE_LIMITS = { days: 42, reminderDays: 30 } as const;

const choreReminderBase = {
  /** The person's reminder revision as read (0: they had none). */
  expectedRevision: z.int().min(0),
  dryRun: z.boolean(),
};

/** A personal reminder: at a date and time, or days before the due day at a time (Home's timezone). */
export const choreReminderSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    ...choreReminderBase,
    mode: z.literal("absolute"),
    localAt: localDateTimeSchema,
  }),
  z.strictObject({
    ...choreReminderBase,
    mode: z.literal("relative"),
    daysBefore: z.int().min(0).max(CHORE_SCHEDULE_LIMITS.reminderDays),
    time: clockTimeSchema,
  }),
]);
export type ChoreReminderInput = z.output<typeof choreReminderSchema>;

export const removeChoreReminderSchema = z.strictObject({ expectedRevision: z.int().min(0) });

/** A schedule read: a Home and an inclusive date range of at most 42 days. */
export const scheduleQuerySchema = z
  .strictObject({ homeId: id, from: dateOnlySchema, to: dateOnlySchema })
  .refine(
    ({ from, to }) => {
      const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
      return days >= 0 && days < CHORE_SCHEDULE_LIMITS.days;
    },
    { message: "invalid", path: ["to"] },
  );

/** The daily summary setting of a chore manager for a Home; the hour is in their own timezone. */
export const summarySettingSchema = z.strictObject({
  homeId: id,
  enabled: z.boolean(),
  hour: z.int().min(0).max(23),
  expectedRevision: z.int().min(0),
});
