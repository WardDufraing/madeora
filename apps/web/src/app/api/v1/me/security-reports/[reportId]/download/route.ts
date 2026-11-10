import { getTranslations } from "next-intl/server";
import { z } from "zod";

import {
  ACTIVITY_OUTCOMES,
  isActivityKind,
  kindKey,
  type ActivityOutcome,
} from "@/activity/catalogue";
import {
  buildCsv,
  buildJson,
  reportFileName,
  type ReportLabels,
  type ReportRow,
} from "@/activity/report";
import { databaseFailure, failure, readActivityMutation } from "@/activity/route-helpers";
import { securityReportDownloadSchema } from "@/activity/schema";
import { storedDevice } from "@/auth/sessions";
import { createSupabaseServerClient } from "@/auth/supabase-server";

interface DownloadRouteContext {
  readonly params: Promise<{ readonly reportId: string }>;
}

/**
 * Downloads one of the signed-in person's own security reports as CSV or JSON (S38). A POST, so
 * a cross-site page cannot trigger it; the database checks again that the report is the caller's,
 * still ready, that this session is live and has a fresh re-authentication. The file is built
 * here from the frozen snapshot and never stored; it is never cached.
 */
export async function POST(request: Request, { params }: DownloadRouteContext): Promise<Response> {
  const input = await readActivityMutation(request, securityReportDownloadSchema);
  if (!input.ok) return input.response;
  const { reportId } = await params;
  if (!z.uuid().safeParse(reportId).success) return failure(404, "not-found");

  const supabase = await createSupabaseServerClient();
  const reports = await supabase.rpc("list_my_security_reports");
  if (reports.error) return databaseFailure("activity.report_download_failed", reports.error);
  const report = reports.data.find((row) => row.id === reportId && row.status === "ready");
  if (!report) return failure(404, "not-found");

  const { data, error } = await supabase.rpc("security_report_rows", { p_report_id: reportId });
  if (error) return databaseFailure("activity.report_download_failed", error);

  const [t, tSecurity] = await Promise.all([
    getTranslations("Activity"),
    getTranslations("Security"),
  ]);
  const rows: ReportRow[] = data.map((row) => {
    const device = row.device_kind
      ? storedDevice(row.device_kind, row.browser, row.platform)
      : null;
    return {
      kind: row.kind,
      outcome: row.outcome,
      homeName: row.home_name || null,
      device: device
        ? tSecurity("deviceName", {
            browser: tSecurity(`browser.${device.browser}`),
            platform: tSecurity(`platform.${device.platform}`),
          })
        : null,
      createdAt: row.created_at,
    };
  });
  const labels: ReportLabels = {
    event: (kind) => (isActivityKind(kind) ? t(kindKey(kind)) : kind),
    outcome: (outcome) =>
      (ACTIVITY_OUTCOMES as readonly string[]).includes(outcome)
        ? t(`outcome.${outcome as ActivityOutcome}`)
        : outcome,
    columns: {
      time: t("reportColumnTime"),
      event: t("reportColumnEvent"),
      outcome: t("reportColumnOutcome"),
      device: t("reportColumnDevice"),
      home: t("reportColumnHome"),
    },
    notes: [
      t("reportNoteScope"),
      t("reportNoteTimeZone", { timeZone: report.timezone }),
      t("reportNoteSnapshot"),
      t("reportNoteExcluded"),
      t("reportNoteRetention"),
    ],
  };
  const meta = {
    from: report.range_from,
    to: report.range_to,
    timeZone: report.timezone,
    snapshotAt: report.snapshot_at,
    generatedAt: new Date().toISOString(),
  };
  const format = input.data.format;
  const body = format === "csv" ? buildCsv(rows, meta, labels) : buildJson(rows, meta, labels);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type":
        format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${reportFileName(meta, format)}"`,
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
    },
  });
}
