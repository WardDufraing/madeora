import "server-only";

import { createSupabaseServerClient } from "@/auth/supabase-server";

import { readLayout } from "./layout";
import { layoutPreview, type LayoutPreview } from "./preview";
import type { DashboardTarget } from "./schema";
import { logDashboard } from "./server";

/** One committed version of a dashboard (UX2c; decision 32), as the history panel shows it. */
export interface HistoryVersion {
  readonly id: string;
  readonly revision: number;
  /** What made this commit: an edit or template ('save'), Undo ('undo'), a restore ('restore'). */
  readonly reason: "save" | "undo" | "restore";
  /** Never who saved a shared-default version, only whether it was the reader. */
  readonly savedByMe: boolean;
  readonly createdAt: string;
  readonly isCurrent: boolean;
  /** Something stored in this version can no longer be shown (an unknown widget, bad settings). */
  readonly dropped: boolean;
  readonly preview: LayoutPreview;
}

export type HistoryResult =
  | { readonly status: "ok"; readonly versions: readonly HistoryVersion[] }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

const reasons = new Set(["save", "undo", "restore"]);

/**
 * The history of `target`, newest first, with the person's own session: the database answers only
 * the person's own personal history, or a Home's shared-default history to someone who may edit it.
 * Layouts are read like a saved dashboard, so a preview never shows what the dashboard could not.
 */
export async function listHistory(target: DashboardTarget): Promise<HistoryResult> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(
    "list_dashboard_versions",
    target.kind === "home" ? { p_home_id: target.homeId, p_target: "default" } : {},
  );
  if (error) {
    if (error.code === "42501") return { status: "not-found" };
    logDashboard("dashboard.history_read_failed", error.code);
    return { status: "unavailable" };
  }
  const versions = data.flatMap((row): HistoryVersion[] => {
    if (!reasons.has(row.reason)) return [];
    const { layout, dropped } = readLayout(row.layout, target.kind);
    return [
      {
        id: row.version_id,
        revision: row.revision,
        reason: row.reason as HistoryVersion["reason"],
        savedByMe: row.saved_by_me,
        createdAt: row.created_at,
        isCurrent: row.is_current,
        dropped,
        preview: layoutPreview(layout),
      },
    ];
  });
  return { status: "ok", versions };
}
