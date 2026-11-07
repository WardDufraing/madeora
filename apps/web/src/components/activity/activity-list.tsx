import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { kindKey } from "@/activity/catalogue";
import {
  hasActivityFilters,
  newestPageHref,
  olderPageHref,
  type ActivityCursor,
  type ActivityFilters,
} from "@/activity/filters";
import type { ActivityPage } from "@/activity/server";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { formatDateTime, isolate, type DateTimeFormats } from "@/invitations/format";

import { SignInResponse } from "./sign-in-response";

export interface ActivityListProps {
  /** The page's own address, for the paging links. */
  readonly path: string;
  readonly page: ActivityPage | null;
  readonly filters: ActivityFilters;
  /** The page shows an older page (a cursor was given). */
  readonly paged: boolean;
  readonly formats: DateTimeFormats;
  /** Hide the category label (the Security activity page shows only one category). */
  readonly securityOnly?: boolean;
}

const outcomeTone: Record<string, string> = {
  completed: "text-fg-muted",
  pending: "text-fg-muted",
  declined: "text-danger",
  blocked: "text-danger",
  failed: "text-danger",
  cancelled: "text-fg-muted",
  expired: "text-fg-muted",
};

/**
 * The person's own history, newest first (S38). Each entry names the event in Madeora's words, its
 * result, the time in the viewer's timezone, the Home it concerned (its name at the time) and who
 * acted as a safe role, never another person's identity. Sign-ins show an approximate device and
 * offer "This was me" / "Secure my account". Distinct empty, no-match and unavailable states.
 */
export async function ActivityList({
  path,
  page,
  filters,
  paged,
  formats,
  securityOnly = false,
}: ActivityListProps) {
  const [t, tSecurity] = await Promise.all([
    getTranslations("Activity"),
    getTranslations("Security"),
  ]);

  if (!page) {
    return (
      <ErrorState
        title={t("unavailableTitle")}
        description={t("unavailableHint")}
        action={
          <Link
            href={newestPageHref(path, filters)}
            className="font-medium text-accent-fg underline"
          >
            {t("retry")}
          </Link>
        }
      />
    );
  }

  const filtered = hasActivityFilters(filters);
  if (page.entries.length === 0) {
    return (
      <>
        {filtered ? (
          <EmptyState
            title={t("noMatchTitle")}
            description={filters.category === "privacy" ? t("privacyEmptyHint") : t("noMatchHint")}
            action={
              <Link href={path} className="font-medium text-accent-fg underline">
                {t("filterClear")}
              </Link>
            }
          />
        ) : (
          <EmptyState title={t("emptyTitle")} description={t("emptyHint")} />
        )}
        {paged ? (
          <Paging
            path={path}
            filters={filters}
            next={null}
            label={t("newestPage")}
            navLabel={t("pagingLabel")}
          />
        ) : null}
        <p className="mt-4 text-helper text-fg-muted">{t("retentionNote")}</p>
      </>
    );
  }

  return (
    <>
      <ol
        aria-label={t("listLabel")}
        className="flex flex-col divide-y divide-line"
        data-testid="activity-list"
      >
        {page.entries.map((entry) => {
          const device = entry.device
            ? tSecurity("deviceName", {
                browser: tSecurity(`browser.${entry.device.browser}`),
                platform: tSecurity(`platform.${entry.device.platform}`),
              })
            : null;
          return (
            <li
              key={entry.id}
              className="flex flex-col gap-1 py-3"
              data-testid="activity-entry"
              data-kind={entry.kind}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-body font-semibold">{t(kindKey(entry.kind))}</span>
                <time dateTime={entry.createdAt} className="text-helper text-fg-muted">
                  {formatDateTime(entry.createdAt, formats)}
                </time>
              </div>
              <p className="flex flex-wrap gap-x-3 gap-y-1 text-helper">
                <span className={outcomeTone[entry.outcome]}>{t(`outcome.${entry.outcome}`)}</span>
                {securityOnly ? null : (
                  <span className="text-fg-muted">{t(`category.${entry.category}`)}</span>
                )}
                <span className="text-fg-muted">{t(`actor.${entry.actor}`)}</span>
              </p>
              {entry.roles ? (
                <p className="text-helper text-fg-muted">
                  {t("roleChange", {
                    from: t(`role.${entry.roles.from}`),
                    to: t(`role.${entry.roles.to}`),
                  })}
                </p>
              ) : null}
              {entry.homeName ? (
                <p className="text-helper text-fg-muted">
                  {entry.isCurrentMember
                    ? t("homeContext", { home: isolate(entry.homeName) })
                    : t("formerHome", { home: isolate(entry.homeName) })}
                </p>
              ) : null}
              {device ? (
                <p className="flex flex-wrap gap-x-3 text-helper text-fg-muted">
                  <span>{device}</span>
                  {entry.isCurrentSession ? (
                    <span className="font-medium text-fg">{t("thisDevice")}</span>
                  ) : null}
                  {entry.alerted ? <span>{t("alertSent")}</span> : null}
                </p>
              ) : null}
              {entry.kind === "signed_in" || entry.kind === "sign_in_unfinished" ? (
                <SignInResponse
                  eventId={entry.id}
                  response={entry.response}
                  label={`${t(kindKey(entry.kind))}, ${formatDateTime(entry.createdAt, formats)}${device ? `, ${device}` : ""}`}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      {page.next || paged ? (
        <Paging
          path={path}
          filters={filters}
          next={page.next}
          label={paged ? t("newestPage") : null}
          olderLabel={t("olderPage")}
          navLabel={t("pagingLabel")}
        />
      ) : null}
      <p className="mt-4 text-helper text-fg-muted">{t("retentionNote")}</p>
    </>
  );
}

function Paging({
  path,
  filters,
  next,
  label,
  olderLabel,
  navLabel,
}: {
  readonly path: string;
  readonly filters: ActivityFilters;
  readonly next: ActivityCursor | null;
  readonly label: string | null;
  readonly olderLabel?: string;
  readonly navLabel: string;
}) {
  return (
    <nav aria-label={navLabel} className="mt-4 flex flex-wrap gap-4">
      {label ? (
        <Link href={newestPageHref(path, filters)} className="font-medium text-accent-fg underline">
          {label}
        </Link>
      ) : null}
      {next && olderLabel ? (
        <Link
          href={olderPageHref(path, filters, next)}
          className="font-medium text-accent-fg underline"
          data-testid="activity-older"
        >
          {olderLabel}
        </Link>
      ) : null}
    </nav>
  );
}
