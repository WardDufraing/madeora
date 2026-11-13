import { z } from "zod";

/**
 * Ora's daily and weekly overviews (S46; spec "Confirmed Ora on-demand daily and weekly
 * overviews"). Client-safe shapes only: the request a person may make, and what the server answers.
 * An overview is read-only; it holds only records the person may see now in one place.
 */

export const overviewModules = ["calendar", "tasks", "chores"] as const;
export type OverviewModule = (typeof overviewModules)[number];

/** A real calendar date in a sensible range (no 2026-02-31, no year 9999). */
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    const year = parsed.getUTCFullYear();
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value &&
      year >= 2000 &&
      year <= 2100
    );
  });

/** The days an overview can cover: a named day, a named week, or a picked day / week. */
export const overviewTargets = [
  "today",
  "tomorrow",
  "this-week",
  "next-week",
  "day",
  "week",
] as const;
export type OverviewTarget = (typeof overviewTargets)[number];

export const overviewFiltersSchema = z.strictObject({
  /** Empty: every module the person may see. */
  modules: z.array(z.enum(overviewModules)).max(3).default([]),
  assignee: z.enum(["anyone", "me", "member"]).default("anyone"),
  /** A membership id, only with `assignee: "member"`. */
  member: z.uuid().optional(),
  completion: z.enum(["all", "open", "done"]).default("all"),
});
export type OverviewFilters = z.output<typeof overviewFiltersSchema>;

export const overviewRequestSchema = z
  .strictObject({
    target: z.enum(overviewTargets),
    /** Required for `day` and `week`: any date inside the day or week. */
    date: dateOnly.optional(),
    filters: overviewFiltersSchema.default({ modules: [], assignee: "anyone", completion: "all" }),
  })
  .refine((request) => (request.target === "day" || request.target === "week") === !!request.date, {
    message: "date",
  })
  .refine((request) => (request.filters.assignee === "member") === !!request.filters.member, {
    message: "member",
  });
export type OverviewRequest = z.output<typeof overviewRequestSchema>;

export const defaultOverviewFilters: OverviewFilters = {
  modules: [],
  assignee: "anyone",
  completion: "all",
};

export type OverviewStatus = "open" | "done" | "overdue" | "pending";

export interface OverviewItem {
  /** Stable for one record on one day, for list keys and de-duplication. */
  readonly key: string;
  readonly module: OverviewModule;
  readonly title: string;
  /** The local date the item belongs to in the shown timezone. */
  readonly day: string;
  /** Only events carry a time: a task or chore due date has none. */
  readonly allDay: boolean;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly timeZone: string;
  readonly status: OverviewStatus;
  /** A page in Madeora (never another site) that shows the record. */
  readonly href: string;
  /** A Home's own event, a personal event, one shared into this Home, or a synced Google event. */
  readonly origin: "own" | "personal" | "shared" | "google";
  readonly assigneeIds: readonly (string | null)[];
  /** The viewer may complete it from its page (a shortcut, never done from the overview). */
  readonly canComplete: boolean;
}

export interface OverviewDay {
  readonly date: string;
  readonly timed: readonly OverviewItem[];
  /** All-day events and anything without a clock time (tasks, chores). */
  readonly untimed: readonly OverviewItem[];
  readonly counts: { readonly [M in OverviewModule]: number };
  /** True for the day(s) that look visibly busier than the rest of the period. */
  readonly busier: boolean;
}

export interface OverviewNotice {
  /** A source that failed, is out of date or cannot be reached. */
  readonly kind: "unavailable" | "stale" | "unverified";
  readonly module: OverviewModule;
  /** A Google calendar's name, when the notice is about one. */
  readonly source: string | null;
  readonly lastSyncedAt: string | null;
}

export type OverviewEmpty = "none" | "filtered" | "incomplete" | null;

export interface Overview {
  readonly homeId: string | null;
  readonly scope: "day" | "week";
  readonly from: string;
  readonly to: string;
  readonly today: string;
  readonly timeZone: string;
  readonly filters: OverviewFilters;
  /** What the filters are applied to; only members the viewer can see. */
  readonly members: readonly {
    readonly id: string;
    readonly name: string | null;
    readonly isSelf: boolean;
    /** An adult the summary can be prepared for (children are never offered). */
    readonly shareable: boolean;
  }[];
  /** The modules the viewer may read here (what the filter chips offer). */
  readonly modules: readonly OverviewModule[];
  readonly days: readonly OverviewDay[];
  readonly notices: readonly OverviewNotice[];
  /** The overview misses some sources: never describe it as complete or a day as free. */
  readonly incomplete: boolean;
  readonly empty: OverviewEmpty;
  /** Most days have the same load: no "busier" note is shown. */
  readonly truncated: boolean;
}

/** A copyable text summary prepared for one audience (S46). */
export interface OverviewShare {
  readonly audience: { readonly id: string; readonly name: string | null };
  readonly text: string;
  readonly incomplete: boolean;
}

export const shareRequestSchema = z.strictObject({
  request: overviewRequestSchema,
  /** The membership id of the intended audience. */
  audience: z.uuid(),
});
export type ShareRequest = z.output<typeof shareRequestSchema>;
