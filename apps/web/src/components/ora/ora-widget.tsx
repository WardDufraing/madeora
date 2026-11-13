import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { getHomeContext } from "@/homes/server";
import { loadOverview } from "@/ora/overview/server";
import { getOraSettings } from "@/ora/server";
import { paletteFor } from "@/ora/settings";
import { defaultOverviewFilters, type OverviewItem } from "@/ora/overview/types";
import type { OraToolContext } from "@/ora/tools/types";
import { isInternalPath } from "@/ora/tools/client";
import { EmptyState, ErrorState } from "@/components/ui/states";

import { OraCharacter } from "./ora-character";
import { OraWidgetActions } from "./ora-widget-actions";

const SHOWN = 3;

/**
 * The optional Ora dashboard widget (S46; design handoff): the character, a compact overview of
 * today (what is planned and what needs attention) and quick actions. Everything is read for the
 * viewer through the same overview code as the panel, so it shows nothing the panel would not; the
 * data lives only in this render. Buttons open the shared panel. If the person turned Ora off, the
 * widget says so instead of showing anything of Ora.
 */
export async function OraWidget({
  home,
}: {
  readonly home: { readonly id: string; readonly name: string } | null;
}) {
  const t = await getTranslations("OraWidget");
  const settings = await getOraSettings();
  if (!settings?.enabled) {
    return (
      <EmptyState
        title={t("offTitle")}
        description={t("offDescription")}
        action={
          <Link href="/settings/ora" className="text-body font-medium text-accent-fg underline">
            {t("settings")}
          </Link>
        }
      />
    );
  }

  let context: OraToolContext = { home: null };
  if (home !== null) {
    const result = await getHomeContext(home.id);
    if (result.status !== "ok") {
      return <ErrorState title={t("failedTitle")} description={t("failed")} />;
    }
    context = { home: { id: result.context.home.id, membership: result.context.membership } };
  }
  const loaded = await loadOverview(context, { target: "today", filters: defaultOverviewFilters });
  if (loaded.status !== "ok") {
    return <ErrorState title={t("failedTitle")} description={t("failed")} />;
  }
  const { overview } = loaded;
  const today = overview.days[0];
  const items: readonly OverviewItem[] = today ? [...today.timed, ...today.untimed] : [];
  const open = items.filter((item) => item.status !== "done");
  const attention = open.filter((item) => item.status === "overdue" || item.status === "pending");
  const palette = paletteFor(settings, home?.id ?? null);

  return (
    <div className="flex flex-col gap-3" data-testid="ora-widget">
      <div className="flex items-start gap-3">
        <OraCharacter
          palette={palette}
          expression="idle"
          motion={settings.motion}
          className="w-14 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium">
            {overview.empty === "incomplete"
              ? t("incomplete")
              : items.length === 0
                ? t("nothing")
                : t("summary", { count: open.length })}
          </p>
          {attention.length > 0 ? (
            <p className="text-helper text-fg-muted">
              {t("attention", { count: attention.length })}
            </p>
          ) : null}
          {overview.incomplete && overview.empty !== "incomplete" ? (
            <p className="text-helper text-fg-muted">{t("someMissing")}</p>
          ) : null}
        </div>
      </div>
      {open.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {open.slice(0, SHOWN).map((item) => (
            <li key={item.key} className="text-helper">
              {isInternalPath(item.href) ? (
                <Link href={item.href} className="underline">
                  {item.title}
                </Link>
              ) : (
                item.title
              )}
              {item.status === "overdue" ? (
                <span className="text-fg-muted"> · {t("overdue")}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <OraWidgetActions />
    </div>
  );
}
