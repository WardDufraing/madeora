import { useTranslations } from "next-intl";
import Link from "next/link";

import { settingsPath } from "@/google-calendar/schema";
import type { GoogleWarning } from "@/google-calendar/shapes";
import type { DateTimeFormats } from "@/invitations/format";
import { formatDateTime } from "@/invitations/format";

/**
 * The Google calendars behind a calendar view that are not up to date (S33; MOD §4.8, PS journey 7):
 * never shown as synced when they are not. The owner reads the reason and is offered the settings;
 * someone else's shared calendar shows only that it is not up to date, with its last sync time.
 */
export function GoogleWarnings({
  warnings,
  names,
  formats,
  compact = false,
}: {
  readonly warnings: readonly GoogleWarning[];
  readonly names: ReadonlyMap<string, string | null>;
  readonly formats: DateTimeFormats;
  readonly compact?: boolean;
}) {
  const t = useTranslations("GoogleCalendar");
  if (warnings.length === 0) return null;
  const ownProblem = warnings.some((w) => w.own && w.state !== "syncing");
  return (
    <div
      className="rounded-card border border-warning bg-surface px-4 py-3 text-body"
      role="status"
      data-testid="google-warnings"
    >
      <ul className="flex flex-col gap-1">
        {warnings.map((warning, index) => {
          const owner = warning.own
            ? null
            : warning.sharedBy
              ? (names.get(warning.sharedBy) ?? null)
              : null;
          const when = warning.lastSyncedAt
            ? t("lastSynced", { when: formatDateTime(warning.lastSyncedAt, formats) })
            : t("neverSynced");
          return (
            <li key={`${warning.calendar}:${String(index)}`} data-state={warning.state}>
              <span className="font-medium">
                <bdi>{warning.calendar}</bdi>
                {owner ? ` (${t("sharedByName", { name: owner })})` : ""}
              </span>
              {": "}
              {t(`warning_${warning.state}`)}
              {compact ? "" : ` ${when}`}
            </li>
          );
        })}
      </ul>
      {ownProblem && !compact ? (
        <Link href={settingsPath} className="mt-2 inline-flex font-medium text-accent-fg underline">
          {t("openSettings")}
        </Link>
      ) : null}
    </div>
  );
}
