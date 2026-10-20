import { z } from "zod";

import { accentPalette, type PaletteId } from "@madeora/design-tokens";
import {
  daysBetween,
  isValidPattern,
  RECURRENCE_LIMITS,
  recurrenceFrequencies,
  type IsoWeekday,
} from "@madeora/domain/tasks";

import { nameProblem, normalizeName } from "@/names/visible-name";

/**
 * The tasks contract (S18, versioned for later mobile clients). Client-safe. Every limit matches the
 * database (`private.task_limit` in supabase/migrations/*_tasks.sql), which checks everything again.
 */
export const TASK_LIMITS = {
  listName: 60,
  labelName: 40,
  title: 200,
  description: 5000,
  comment: 2000,
  page: 50,
  maxOffset: 10000,
  commentsPage: 100,
  labelsPerTask: 20,
  assigneesPerTask: 20,
  subtasks: 100,
  lists: 100,
  labels: 100,
  /** S19: days a recurring task's start date may lie before its due date; history page size. */
  startOffset: 365,
  historyPage: 50,
  /** S19b: days a reminder may come before the due date; templates; tasks in one bulk action. */
  reminderDays: 30,
  templateName: 60,
  templates: 100,
  bulk: 100,
} as const;

export const taskPriorities = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof taskPriorities)[number];

/**
 * Label colours are the accent palette's ids (packages/design-tokens palette.ts, also listed in the
 * database check); `null` is the neutral default. A label always shows its name, never colour alone.
 */
export const labelColors: readonly PaletteId[] = accentPalette.map((entry) => entry.id);
export type LabelColor = PaletteId;

export function isLabelColor(value: unknown): value is LabelColor {
  return typeof value === "string" && (labelColors as readonly string[]).includes(value);
}

const labelColorSchema = z.custom<LabelColor>(isLabelColor, "invalid");

export const taskStatuses = ["open", "completed", "all"] as const;
export type TaskStatus = (typeof taskStatuses)[number];
export const taskWhens = ["any", "upcoming", "active", "overdue"] as const;
export type TaskWhen = (typeof taskWhens)[number];
export const taskSorts = ["due", "priority_desc", "priority_asc", "created"] as const;
export type TaskSort = (typeof taskSorts)[number];
export const assigneeFilters = ["any", "me", "unassigned", "needs_reassignment", "member"] as const;
export type AssigneeFilter = (typeof assigneeFilters)[number];
export const priorityFilters = [...taskPriorities, "unset"] as const;
export type PriorityFilter = (typeof priorityFilters)[number];

/** Field error codes the forms translate. */
export type TaskFieldError = "required" | "tooLong" | "invalidCharacters" | "dateOrder" | "invalid";

const id = z.uuid();

/**
 * A name others see (lists, labels, task and subtask titles): normalized and trimmed as stored, then
 * the S09 visible-name policy (`private.is_visible_name`) with its own length.
 */
function nameSchema(max: number) {
  return z
    .string({ error: "required" satisfies TaskFieldError })
    .max(4 * max, { error: "tooLong" satisfies TaskFieldError })
    .transform((value, context) => {
      const name = normalizeName(value);
      if (name === "") {
        context.addIssue({ code: "custom", message: "required" satisfies TaskFieldError });
        return z.NEVER;
      }
      const problem = nameProblem(name, max);
      if (problem) {
        context.addIssue({
          code: "custom",
          message: (problem === "tooLong"
            ? "tooLong"
            : "invalidCharacters") satisfies TaskFieldError,
        });
        return z.NEVER;
      }
      return name;
    });
}

export const listNameSchema = nameSchema(TASK_LIMITS.listName);
export const labelNameSchema = nameSchema(TASK_LIMITS.labelName);
export const taskTitleSchema = nameSchema(TASK_LIMITS.title);

// Tab, line feed and carriage return are the only control characters plain text may hold.
// eslint-disable-next-line no-control-regex -- the point of the check is control characters
const forbiddenControls = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

/** Plain multi-line text: at most `max` characters (code points), not only whitespace. */
export function plainTextSchema(max: number) {
  return z
    .string()
    .refine((value) => value.trim().length > 0, "required")
    .refine((value) => Array.from(value).length <= max, "tooLong")
    .refine((value) => !forbiddenControls.test(value), "invalidCharacters");
}

/** An optional description: empty (or only whitespace) means none. */
export const descriptionSchema = z
  .string()
  .transform((value) => (value.trim() === "" ? null : value))
  .pipe(plainTextSchema(TASK_LIMITS.description).nullable());

export const commentBodySchema = plainTextSchema(TASK_LIMITS.comment);

/** A calendar date, `YYYY-MM-DD`, that exists. Date-only: never turned into an instant. */
export const dateOnlySchema = z.iso.date();

const optionalDate = dateOnlySchema.nullable();

/** Who owns a list, label or task: the Personal space (null) or a Home. */
export const contextSchema = z.uuid().nullable();

export const taskFieldsSchema = z
  .strictObject({
    title: taskTitleSchema,
    description: descriptionSchema.nullable(),
    startDate: optionalDate,
    dueDate: optionalDate,
    priority: z.enum(taskPriorities).nullable(),
    labelIds: z.array(id).max(TASK_LIMITS.labelsPerTask),
  })
  .refine(
    (task) => task.startDate === null || task.dueDate === null || task.startDate <= task.dueDate,
    { message: "dateOrder", path: ["dueDate"] },
  );
export type TaskFields = z.output<typeof taskFieldsSchema>;

/**
 * A recurring task's schedule (S19): daily, weekly on chosen ISO weekdays (1 Monday … 7 Sunday),
 * monthly or yearly, every `interval`; it ends never, on `endsOn`, or after `count` occurrences.
 * `startsOn` is the first date and the anchor of the rhythm. The database checks it again
 * (`private.valid_series_rule`) and decides which occurrences exist.
 */
export const recurrenceSchema = z
  .strictObject({
    frequency: z.enum(recurrenceFrequencies),
    interval: z.int().min(1).max(RECURRENCE_LIMITS.interval),
    weekdays: z
      .array(z.int().min(1).max(7))
      .min(1)
      .max(7)
      .transform((days) => [...days].sort((a, b) => a - b) as IsoWeekday[])
      .nullable(),
    startsOn: dateOnlySchema,
    endsOn: dateOnlySchema.nullable(),
    count: z.int().min(1).max(RECURRENCE_LIMITS.count).nullable(),
  })
  .refine((rule) => isValidPattern(rule), { message: "invalid", path: ["weekdays"] })
  .refine((rule) => rule.endsOn === null || rule.endsOn >= rule.startsOn, {
    message: "dateOrder",
    path: ["endsOn"],
  });
export type RecurrenceInput = z.output<typeof recurrenceSchema>;

/** Days between a start and a due date, as a series' start offset; null without a start date. */
export function startOffsetOf(startDate: string | null, dueDate: string): number | null {
  return startDate === null ? null : daysBetween(startDate, dueDate);
}

export const createTaskSchema = z
  .strictObject({
    id,
    homeId: contextSchema,
    listId: id,
    title: taskTitleSchema,
    description: descriptionSchema.nullable(),
    startDate: optionalDate,
    dueDate: optionalDate,
    priority: z.enum(taskPriorities).nullable(),
    labelIds: z.array(id).max(TASK_LIMITS.labelsPerTask),
    assigneeIds: z.array(id).max(TASK_LIMITS.assigneesPerTask),
    /** S19: makes it a recurring task; its first date is the due date. */
    recurrence: recurrenceSchema.nullish(),
  })
  .refine(
    (task) => task.startDate === null || task.dueDate === null || task.startDate <= task.dueDate,
    { message: "dateOrder", path: ["dueDate"] },
  )
  .refine((task) => task.homeId !== null || task.assigneeIds.length === 0, {
    message: "invalid",
    path: ["assigneeIds"],
  })
  .refine((task) => !task.recurrence || task.dueDate === task.recurrence.startsOn, {
    message: "required",
    path: ["dueDate"],
  })
  .refine(
    (task) =>
      !task.recurrence ||
      task.dueDate === null ||
      (startOffsetOf(task.startDate, task.dueDate) ?? 0) <= TASK_LIMITS.startOffset,
    { message: "tooLong", path: ["startDate"] },
  );
export type CreateTaskInput = z.output<typeof createTaskSchema>;

export const updateTaskSchema = z
  .strictObject({
    expectedRevision: z.int().min(1),
    title: taskTitleSchema,
    description: descriptionSchema.nullable(),
    startDate: optionalDate,
    dueDate: optionalDate,
    priority: z.enum(taskPriorities).nullable(),
    labelIds: z.array(id).max(TASK_LIMITS.labelsPerTask),
  })
  .refine(
    (task) => task.startDate === null || task.dueDate === null || task.startDate <= task.dueDate,
    { message: "dateOrder", path: ["dueDate"] },
  );
export type UpdateTaskInput = z.output<typeof updateTaskSchema>;

export const setAssigneesSchema = z.strictObject({
  expectedRevision: z.int().min(1),
  memberIds: z.array(id).max(TASK_LIMITS.assigneesPerTask),
});
export const moveTaskSchema = z.strictObject({ expectedRevision: z.int().min(1), listId: id });
export const completionSchema = z.strictObject({ completed: z.boolean() });

export const seriesScopes = ["following", "series"] as const;
export type SeriesScope = (typeof seriesScopes)[number];

/**
 * A change to this and following occurrences, or the entire series (S19). Each part is optional,
 * at least one is given. `dryRun` asks for the impact only (the same work, rolled back).
 */
export const seriesChangeSchema = z
  .strictObject({
    scope: z.enum(seriesScopes),
    expectedTaskRevision: z.int().min(1),
    expectedSeriesRevision: z.int().min(1),
    dryRun: z.boolean(),
    content: z
      .strictObject({
        title: taskTitleSchema,
        description: descriptionSchema.nullable(),
        priority: z.enum(taskPriorities).nullable(),
        labelIds: z.array(id).max(TASK_LIMITS.labelsPerTask),
        startOffset: z.int().min(0).max(TASK_LIMITS.startOffset).nullable(),
        /** This occurrence's checklist becomes the checklist of occurrences created from now on. */
        copySubtasks: z.boolean(),
      })
      .optional(),
    listId: id.optional(),
    assigneeIds: z.array(id).max(TASK_LIMITS.assigneesPerTask).optional(),
    schedule: recurrenceSchema.optional(),
  })
  .refine(
    (change) =>
      change.content !== undefined ||
      change.listId !== undefined ||
      change.assigneeIds !== undefined ||
      change.schedule !== undefined,
    { message: "required", path: ["content"] },
  );
export type SeriesChangeInput = z.output<typeof seriesChangeSchema>;

export const seriesDeleteSchema = z.strictObject({
  scope: z.enum(seriesScopes),
  expectedSeriesRevision: z.int().min(1),
  dryRun: z.boolean(),
});
export type SeriesDeleteInput = z.output<typeof seriesDeleteSchema>;

export const seriesPausedSchema = z.strictObject({
  paused: z.boolean(),
  expectedSeriesRevision: z.int().min(1),
});

export const occurrenceFilters = ["all", "completed", "missed"] as const;
export type OccurrenceFilter = (typeof occurrenceFilters)[number];
export const occurrenceQuerySchema = z.strictObject({
  filter: z.enum(occurrenceFilters).default("all"),
  offset: z.coerce.number().int().min(0).max(TASK_LIMITS.maxOffset).default(0),
});

export const addSubtaskSchema = z.strictObject({ id, title: taskTitleSchema });
export const updateSubtaskSchema = z.union([
  z.strictObject({ expectedRevision: z.int().min(1), title: taskTitleSchema }),
  z.strictObject({ completed: z.boolean() }),
]);
export const orderSchema = z.strictObject({
  ids: z.array(id).min(1).max(TASK_LIMITS.lists),
});
export const subtaskOrderSchema = z.strictObject({
  ids: z.array(id).min(1).max(TASK_LIMITS.subtasks),
});

export const addCommentSchema = z.strictObject({ id, body: commentBodySchema });
export const updateCommentSchema = z.strictObject({
  expectedRevision: z.int().min(1),
  body: commentBodySchema,
});

export const createListSchema = z.strictObject({ id, homeId: contextSchema, name: listNameSchema });
export const updateListSchema = z.strictObject({
  expectedRevision: z.int().min(1),
  name: listNameSchema,
  archived: z.boolean(),
});
export const listOrderSchema = z.strictObject({
  homeId: contextSchema,
  ids: z.array(id).min(1).max(TASK_LIMITS.lists),
});
export const revisionSchema = z.strictObject({ expectedRevision: z.int().min(1) });

export const createLabelSchema = z.strictObject({
  id,
  homeId: contextSchema,
  name: labelNameSchema,
  color: labelColorSchema.nullable(),
});
export const updateLabelSchema = z.strictObject({
  expectedRevision: z.int().min(1),
  name: labelNameSchema,
  color: labelColorSchema.nullable(),
});

// S19b: reminders, templates and bulk actions ---------------------------------------------------

/** Who a reminder change reaches: this task only, or (an occurrence) following or all of them. */
export const reminderScopes = ["this", ...seriesScopes] as const;
export type ReminderScope = (typeof reminderScopes)[number];

/** A wall-clock time, `HH:MM`. */
export const clockTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

/** A wall-clock date and time, `YYYY-MM-DDTHH:MM`, without a zone: the server applies the zone. */
export const localDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/)
  .refine((value) => dateOnlySchema.safeParse(value.slice(0, 10)).success);

const reminderBase = {
  scope: z.enum(reminderScopes),
  /** The task's reminder revision as read (0: it had none). */
  expectedRevision: z.int().min(0),
  /** The series' reminder revision as read (0: none); required for the series scopes. */
  expectedSeriesRevision: z.int().min(0).nullable(),
  dryRun: z.boolean(),
};

/**
 * A reminder: at a date and time, or a number of days before the due date at a time. Only the
 * second can apply to following or all occurrences. The zone is the Home's, or the person's own
 * for the Personal space; the server resolves it and its DST cases.
 */
export const setReminderSchema = z
  .discriminatedUnion("mode", [
    z.strictObject({ ...reminderBase, mode: z.literal("absolute"), localAt: localDateTimeSchema }),
    z.strictObject({
      ...reminderBase,
      mode: z.literal("relative"),
      daysBefore: z.int().min(0).max(TASK_LIMITS.reminderDays),
      time: clockTimeSchema,
    }),
  ])
  .refine((input) => input.scope === "this" || input.mode === "relative", {
    message: "invalid",
    path: ["mode"],
  })
  .refine((input) => input.scope === "this" || input.expectedSeriesRevision !== null, {
    message: "required",
    path: ["expectedSeriesRevision"],
  });
export type SetReminderInput = z.output<typeof setReminderSchema>;

export const removeReminderSchema = z
  .strictObject(reminderBase)
  .refine((input) => input.scope === "this" || input.expectedSeriesRevision !== null, {
    message: "required",
    path: ["expectedSeriesRevision"],
  });
export type RemoveReminderInput = z.output<typeof removeReminderSchema>;

export const reviewReminderSchema = z.strictObject({
  choice: z.enum(["follow", "remove"]),
  expectedRevision: z.int().min(1),
});

export const templateNameSchema = nameSchema(TASK_LIMITS.templateName);

/** What a template holds: never dates, people, comments, completion, reminders or recurrence. */
const templateContent = {
  name: templateNameSchema,
  title: taskTitleSchema,
  description: descriptionSchema.nullable(),
  priority: z.enum(taskPriorities).nullable(),
  labelIds: z.array(id).max(TASK_LIMITS.labelsPerTask),
  subtasks: z.array(taskTitleSchema).max(TASK_LIMITS.subtasks),
};

export const createTemplateSchema = z.strictObject({
  id,
  homeId: contextSchema,
  ...templateContent,
});
export type CreateTemplateInput = z.output<typeof createTemplateSchema>;

export const updateTemplateSchema = z.strictObject({
  expectedRevision: z.int().min(1),
  ...templateContent,
});
export type UpdateTemplateInput = z.output<typeof updateTemplateSchema>;

/** A task from a template's reviewed preview: what the person confirmed, into one list. */
export const createFromTemplateSchema = z
  .strictObject({
    taskId: id,
    expectedTemplateRevision: z.int().min(1),
    listId: id,
    title: taskTitleSchema,
    description: descriptionSchema.nullable(),
    priority: z.enum(taskPriorities).nullable(),
    labelIds: z.array(id).max(TASK_LIMITS.labelsPerTask),
    subtasks: z.array(taskTitleSchema).max(TASK_LIMITS.subtasks),
    startDate: optionalDate,
    dueDate: optionalDate,
  })
  .refine(
    (task) => task.startDate === null || task.dueDate === null || task.startDate <= task.dueDate,
    { message: "dateOrder", path: ["dueDate"] },
  );
export type CreateFromTemplateInput = z.output<typeof createFromTemplateSchema>;

export const bulkActions = ["complete", "priority", "labels", "move"] as const;
export type BulkAction = (typeof bulkActions)[number];
export const labelModes = ["add", "remove", "replace"] as const;
export type LabelMode = (typeof labelModes)[number];

const bulkBase = {
  homeId: contextSchema,
  taskIds: z.array(id).min(1).max(TASK_LIMITS.bulk),
  /** Each task's revision as previewed; required to apply (not for the preview). */
  expectedRevisions: z.record(id, z.int().min(1)).nullable(),
  dryRun: z.boolean(),
};

/** One basic action on selected tasks of one context (spec "basic bulk task actions"). */
export const bulkSchema = z
  .discriminatedUnion("action", [
    z.strictObject({ ...bulkBase, action: z.literal("complete") }),
    z.strictObject({
      ...bulkBase,
      action: z.literal("priority"),
      priority: z.enum(taskPriorities).nullable(),
    }),
    z.strictObject({
      ...bulkBase,
      action: z.literal("labels"),
      labelMode: z.enum(labelModes),
      labelIds: z.array(id).max(TASK_LIMITS.labelsPerTask),
    }),
    z.strictObject({ ...bulkBase, action: z.literal("move"), listId: id }),
  ])
  .refine((input) => input.dryRun || input.expectedRevisions !== null, {
    message: "required",
    path: ["expectedRevisions"],
  });
export type BulkInput = z.output<typeof bulkSchema>;

/** One value or several of a search parameter, as Next.js gives them. */
const many = <T extends z.ZodType>(item: T) =>
  z
    .union([item, z.array(item)])
    .optional()
    .transform((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]));

/** The filters of a task listing, from a query string or search params. Unknown values fail. */
export const taskQuerySchema = z.object({
  list: id.optional(),
  status: z.enum(taskStatuses).default("open"),
  when: z.enum(taskWhens).default("any"),
  /** "1": leave out tasks that start after today (not with `when=upcoming`). */
  hideFuture: z.enum(["0", "1"]).default("1"),
  priority: many(z.enum(priorityFilters)),
  label: many(id).pipe(z.array(id).max(TASK_LIMITS.labels)),
  assignee: z.enum(assigneeFilters).default("any"),
  member: id.optional(),
  sort: z.enum(taskSorts).default("due"),
  offset: z.coerce.number().int().min(0).max(TASK_LIMITS.maxOffset).default(0),
});
export type TaskQuery = z.output<typeof taskQuerySchema>;
