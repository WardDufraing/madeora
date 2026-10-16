import { z } from "zod";

import { accentPalette, type PaletteId } from "@madeora/design-tokens";

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
  })
  .refine(
    (task) => task.startDate === null || task.dueDate === null || task.startDate <= task.dueDate,
    { message: "dateOrder", path: ["dueDate"] },
  )
  .refine((task) => task.homeId !== null || task.assigneeIds.length === 0, {
    message: "invalid",
    path: ["assigneeIds"],
  });
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
