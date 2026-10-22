import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { EmptyState, ErrorState } from "@/components/ui/states";
import type { DateTimeFormats } from "@/invitations/format";
import { getVacationWidget } from "@/vacations/data";
import { rangeText, vacationsPath } from "@/vacations/format";

/**
 * The Home vacation widget (S22): the active vacation, else the next upcoming one, with its dates,
 * status, scope ("Whole Home away", "N members away", "You are away") and whether chores are paused;
 * a calm empty state otherwise. Scope labels only: it never names who is away.
 */
export async function HomeVacationWidget({
  homeId,
  formats,
}: {
  readonly homeId: string;
  readonly formats: DateTimeFormats;
}) {
  const [t, data] = await Promise.all([getTranslations("Vacations"), getVacationWidget(homeId)]);
  if (data.status !== "ok") {
    return <ErrorState title={t("widgetFailedTitle")} description={t("widgetFailed")} />;
  }
  const { vacation, pausedToday, others } = data.value;
  const link = (
    <Link href={vacationsPath(homeId)} className="text-helper font-medium text-accent-fg underline">
      {t("widgetOpen")}
    </Link>
  );
  if (!vacation) {
    return (
      <div className="flex flex-col gap-2" data-testid="vacation-widget">
        <EmptyState title={t("widgetEmptyTitle")} description={t("widgetEmpty")} />
        {link}
      </div>
    );
  }
  const scope =
    vacation.scope === "everyone"
      ? t("widgetScopeEveryone")
      : vacation.scope === "me"
        ? t("widgetScopeMe")
        : vacation.me
          ? t("widgetScopeMembersWithMe", { count: vacation.awayCount })
          : t("widgetScopeMembers", { count: vacation.awayCount });
  return (
    <div className="flex flex-col gap-1 text-body text-fg" data-testid="vacation-widget">
      <Link
        href={`${vacationsPath(homeId)}/${vacation.id}`}
        className="font-semibold text-fg underline-offset-2 hover:underline"
      >
        <bdi>{vacation.name ?? t("genericName")}</bdi>
      </Link>
      <p>
        {t(`status_${vacation.status}`)}
        {" \u{00B7} "}
        {rangeText(vacation.startsOn, vacation.endsOn, formats)}
      </p>
      <p data-testid="vacation-widget-scope">{scope}</p>
      {pausedToday ? (
        <p className="font-semibold">{t("widgetPausedToday")}</p>
      ) : vacation.pauseDates.length > 0 ? (
        <p>{t("widgetPauseConfirmed")}</p>
      ) : null}
      {others > 0 ? (
        <p className="text-helper text-fg-muted">{t("widgetOthers", { count: others })}</p>
      ) : null}
      {link}
    </div>
  );
}
