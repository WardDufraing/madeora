import "server-only";

import type { WidgetConfigs } from "@/dashboard/widgets";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { listTaskMembers } from "@/tasks/data";
import type { MemberOption } from "@/tasks/format";
import { isLabelColor, type LabelColor } from "@/tasks/schema";

import type { ChoreApproval } from "./api";
import { advanceChores, getChoreContext, listChoreApprovals } from "./data";
import { logChores } from "./log";
import { nullable } from "./route-helpers";

/**
 * What a chore widget shows (S20), read with the viewer's own session like the Chores pages, for
 * one Home only. A member the settings name who is no longer in the Home is reported, never
 * replaced, and matches nobody. Pending Approvals reads the review queue only for a current
 * reviewer; anyone else gets a permission state with no titles or counts.
 */

export type ChoreWidgetKind = "my-chores" | "home-chores";
export type ChoreListConfig = WidgetConfigs["my-chores"] | WidgetConfigs["home-chores"];

export interface ChoreWidgetRow {
  readonly id: string;
  readonly title: string;
  readonly category: { readonly name: string; readonly color: LabelColor | null } | null;
  readonly dueDate: string;
  readonly status: "open" | "pending_approval" | "completed";
  readonly overdue: boolean;
  readonly inRework: boolean;
  readonly requiresApproval: boolean;
  readonly assigneeIds: readonly string[];
  readonly assignedToMe: boolean;
  readonly mandatoryOpen: number;
  readonly completedAt: string | null;
  readonly contributor: { readonly me: boolean; readonly member: string | null } | null;
}

export type ChoreWidgetData =
  | {
      readonly status: "ok";
      readonly rows: readonly ChoreWidgetRow[];
      readonly total: number;
      readonly members: readonly MemberOption[];
      /** The Home's today, the base of the date range. */
      readonly today: string;
      readonly from: string | null;
      readonly to: string | null;
      readonly missingMember: boolean;
    }
  | { readonly status: "unavailable" };

export type ChoreApprovalsWidgetData =
  | {
      readonly status: "ok";
      readonly approvals: readonly ChoreApproval[];
      readonly total: number;
      readonly members: readonly MemberOption[];
    }
  | { readonly status: "not-reviewer" }
  | { readonly status: "unavailable" };

/** The date range of a relative setting, from the Home's today (date-only, so DST never shifts it). */
export function choreWidgetRange(
  range: ChoreListConfig["range"],
  today: string,
): { readonly from: string | null; readonly to: string | null } {
  const shift = (days: number) => {
    const date = new Date(`${today}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  switch (range) {
    case "any":
      return { from: null, to: null };
    case "today":
      return { from: today, to: today };
    case "next_7_days":
      return { from: today, to: shift(6) };
    case "past_7_days":
      return { from: shift(-6), to: today };
  }
}

export async function loadChoreWidget(
  homeId: string,
  kind: ChoreWidgetKind,
  config: ChoreListConfig,
): Promise<ChoreWidgetData> {
  // Recurring chores create their due occurrences before anything is read (lazy generation).
  await advanceChores(homeId);
  const [context, members] = await Promise.all([getChoreContext(homeId), listTaskMembers(homeId)]);
  if (context.status !== "ok" || members.status !== "ok") return { status: "unavailable" };
  const today = context.value.today;
  const { from, to } = choreWidgetRange(config.range, today);
  const assignee = "assignee" in config ? config.assignee : "any";
  const memberId = "memberId" in config ? config.memberId : null;
  const memberKnown = memberId !== null && members.value.some((member) => member.id === memberId);
  const missingMember = assignee === "member" && !memberKnown;
  if (missingMember) {
    return {
      status: "ok",
      rows: [],
      total: 0,
      members: members.value,
      today,
      from,
      to,
      missingMember,
    };
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_chore_widget", {
    p_home_id: homeId,
    p_view: kind === "my-chores" ? "mine" : "all",
    p_state: config.state,
    ...(from ? { p_from: from } : {}),
    ...(to ? { p_to: to } : {}),
    ...(assignee === "member" && memberId ? { p_member: memberId } : {}),
    p_unassigned: assignee === "unassigned",
    p_limit: config.count,
  });
  if (error) {
    if (error.code !== "42501") logChores("chores.widget_failed", error.code);
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    total: data[0]?.total_count ?? 0,
    members: members.value,
    today,
    from,
    to,
    missingMember,
    rows: data.map((row) => {
      const categoryName = nullable(row.category_name);
      const color = nullable(row.category_color);
      const completedAt = nullable(row.completed_at);
      const contributor = nullable(row.contributor_member);
      return {
        id: row.id,
        title: row.title,
        category:
          categoryName === null
            ? null
            : { name: categoryName, color: isLabelColor(color) ? color : null },
        dueDate: row.due_date,
        status:
          row.status === "pending_approval" || row.status === "completed" ? row.status : "open",
        overdue: row.overdue,
        inRework: row.in_rework,
        requiresApproval: row.requires_approval,
        assigneeIds: row.assignee_member_ids,
        assignedToMe: row.assigned_to_me,
        mandatoryOpen: row.mandatory_open,
        completedAt,
        contributor: completedAt === null ? null : { me: row.contributor_me, member: contributor },
      };
    }),
  };
}

export async function loadChoreApprovalsWidget(
  homeId: string,
  count: number,
): Promise<ChoreApprovalsWidgetData> {
  const [context, approvals, members] = await Promise.all([
    getChoreContext(homeId),
    listChoreApprovals(homeId),
    listTaskMembers(homeId),
  ]);
  if (context.status !== "ok" || approvals.status !== "ok" || members.status !== "ok") {
    return { status: "unavailable" };
  }
  if (!context.value.canReview) return { status: "not-reviewer" };
  return {
    status: "ok",
    approvals: approvals.value.slice(0, count),
    total: approvals.value.length,
    members: members.value,
  };
}
