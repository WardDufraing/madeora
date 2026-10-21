"use client";

import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useState } from "react";

import { LabelChip } from "@/components/tasks/label-chip";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import {
  CHORE_OCCURRENCES_ENDPOINT,
  sendChoreRequest,
  type ChorePool as ChorePoolData,
  type ChorePoolRow,
  type ClaimResponse,
} from "@/chores/api";
import {
  defaultPoolFilter,
  filterPool,
  isDefaultPoolFilter,
  poolDurations,
  type PoolDuration,
  type PoolFilter,
} from "@/chores/pool";
import type { DateTimeFormats } from "@/invitations/format";
import { addDays } from "@/tasks/calendar";
import { formatTaskDate } from "@/tasks/format";

import { useClaimToasts } from "./use-claim-undo";
import { useChoreMutation } from "./use-chore-mutation";

export interface ChorePoolProps {
  readonly homeId: string;
  readonly pool: ChorePoolData;
  /** The shown week (Home-local) and links to its neighbours and to this week. */
  readonly week: {
    readonly start: string;
    readonly current: boolean;
    readonly previousHref: string;
    readonly nextHref: string;
    readonly currentHref: string;
  };
  readonly today: string;
  /** Every category, archived ones too: their chores still show. */
  readonly categories: readonly { readonly id: string; readonly name: string }[];
  readonly formats: DateTimeFormats;
}

/**
 * The Home's unassigned chores (S21; spec "weekly unassigned chore pool"): this week's (today
 * marked) and the overdue ones still available, earliest due first. Filters by category (with
 * Uncategorized), due dates and duration (with Not set), the due-date direction and "only what I
 * can claim" change this person's view only, with matching and total counts and one reset. Every
 * eligible row has one-tap Claim with a short Undo; a restricted chore says only that the viewer is
 * not eligible, never who is. Points come with S23.
 */
export function ChorePool({ homeId, pool, week, today, categories, formats }: ChorePoolProps) {
  const t = useTranslations("Chores");
  const locale = useLocale();
  const [filter, setFilter] = useState<PoolFilter>(defaultPoolFilter);
  const collator = useMemo(() => new Intl.Collator(locale, { sensitivity: "base" }), [locale]);
  const weekday = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }),
    [locale],
  );
  const shown = filterPool(pool.rows, filter, collator);
  const filtered = !isDefaultPoolFilter(filter);
  const set = <K extends keyof PoolFilter>(key: K, value: PoolFilter[K]) => {
    setFilter((current) => ({ ...current, [key]: value }));
  };
  const day = (date: string) =>
    `${weekday.format(new Date(`${date}T00:00:00Z`))} ${formatTaskDate(date, formats)}`;
  const sections = [
    { id: "week", title: t("poolWeek"), rows: shown.filter((row) => row.section === "week") },
    {
      id: "overdue",
      title: t("poolOverdue"),
      rows: shown.filter((row) => row.section === "overdue"),
    },
  ] as const;
  const durationLabel: Record<PoolDuration, string> = {
    any: t("poolDurationAny"),
    none: t("poolDurationNone"),
    "15": t("poolDurationUpTo", { count: 15 }),
    "30": t("poolDurationUpTo", { count: 30 }),
    "60": t("poolDurationUpTo", { count: 60 }),
    more: t("poolDurationMore"),
  };

  return (
    <section
      aria-labelledby="chore-pool-heading"
      className="flex flex-col gap-3"
      data-testid="chore-pool"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="chore-pool-heading" className="text-section-title font-semibold text-fg">
          {t("poolHeading")}{" "}
          <span className="text-body font-normal text-fg-muted" data-testid="chore-pool-count">
            {filtered
              ? t("poolMatching", { shown: shown.length, total: pool.rows.length })
              : t("groupCount", { count: pool.rows.length })}
          </span>
        </h2>
        <nav aria-label={t("poolWeekNav")} className="flex flex-wrap gap-x-3 text-body">
          <Link href={week.previousHref} className="font-medium text-accent-fg underline">
            {t("poolPreviousWeek")}
          </Link>
          {week.current ? null : (
            <Link href={week.currentHref} className="font-medium text-accent-fg underline">
              {t("poolThisWeek")}
            </Link>
          )}
          <Link href={week.nextHref} className="font-medium text-accent-fg underline">
            {t("poolNextWeek")}
          </Link>
        </nav>
      </div>
      <p className="text-helper text-fg-muted">
        {t("poolWeekRange", {
          from: formatTaskDate(week.start, formats),
          to: formatTaskDate(addDays(week.start, 6), formats),
        })}
      </p>
      <HydrationGate>
        <details
          className="rounded-card border border-line bg-surface p-3"
          data-testid="pool-filters"
        >
          <summary className="cursor-pointer text-body font-medium text-fg">
            {filtered ? t("poolFiltersActive") : t("poolFilters")}
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <SelectField
              label={t("fieldCategory")}
              value={filter.category}
              onChange={(event) => {
                set("category", event.target.value);
              }}
              options={[
                { value: "any", label: t("categoryAny") },
                { value: "none", label: t("uncategorized") },
                ...categories.map((category) => ({ value: category.id, label: category.name })),
              ]}
            />
            <SelectField
              label={t("poolDuration")}
              value={filter.duration}
              onChange={(event) => {
                const value = poolDurations.find((option) => option === event.target.value);
                set("duration", value ?? "any");
              }}
              options={poolDurations.map((value) => ({ value, label: durationLabel[value] }))}
            />
            <TextField
              type="date"
              label={t("poolDueFrom")}
              value={filter.from}
              onChange={(event) => {
                set("from", event.target.value);
              }}
            />
            <TextField
              type="date"
              label={t("poolDueTo")}
              value={filter.to}
              onChange={(event) => {
                set("to", event.target.value);
              }}
            />
            <SelectField
              label={t("poolSort")}
              value={filter.sort}
              onChange={(event) => {
                set("sort", event.target.value === "desc" ? "desc" : "asc");
              }}
              options={[
                { value: "asc", label: t("poolSortEarliest") },
                { value: "desc", label: t("poolSortLatest") },
              ]}
            />
            <Checkbox
              label={t("poolOnlyClaimable")}
              checked={filter.onlyClaimable}
              onChange={(event) => {
                set("onlyClaimable", event.target.checked);
              }}
              className="self-end"
            />
          </div>
          {filtered ? (
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => {
                setFilter(defaultPoolFilter);
              }}
              data-testid="pool-reset"
            >
              {t("poolReset")}
            </Button>
          ) : null}
        </details>
      </HydrationGate>
      {pool.rows.length === 0 ? (
        <p className="rounded-card border border-line bg-surface p-3 text-body text-fg-muted">
          {t("poolEmpty")}
        </p>
      ) : shown.length === 0 ? (
        <p className="rounded-card border border-line bg-surface p-3 text-body text-fg-muted">
          {t("poolNoMatch")}
        </p>
      ) : (
        sections.map((section) =>
          section.rows.length === 0 ? null : (
            <div
              key={section.id}
              className="flex flex-col gap-2"
              data-testid={`pool-${section.id}`}
            >
              <h3 className="text-body font-semibold text-fg">
                {section.title}{" "}
                <span className="font-normal text-fg-muted">
                  {t("groupCount", { count: section.rows.length })}
                </span>
              </h3>
              <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
                {section.rows.map((row) => (
                  <PoolRow
                    key={row.id}
                    row={row}
                    href={`/homes/${homeId}/chores/${row.id}`}
                    day={day(row.dueDate)}
                    isToday={row.dueDate === today}
                    lastDay={
                      row.closesOn ? formatTaskDate(addDays(row.closesOn, -1), formats) : null
                    }
                  />
                ))}
              </ul>
            </div>
          ),
        )
      )}
      {pool.truncated ? <p className="text-helper text-fg-muted">{t("poolTruncated")}</p> : null}
    </section>
  );
}

function PoolRow({
  row,
  href,
  day,
  isToday,
  lastDay,
}: {
  readonly row: ChorePoolRow;
  readonly href: string;
  readonly day: string;
  readonly isToday: boolean;
  readonly lastDay: string | null;
}) {
  const t = useTranslations("Chores");
  return (
    <li
      className={`flex flex-wrap items-center justify-between gap-3 p-3${isToday ? " bg-accent-subtle" : ""}`}
      data-testid="pool-row"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <Link
          href={href}
          className="text-body font-semibold text-fg underline-offset-2 hover:underline"
        >
          <bdi>{row.title}</bdi>
        </Link>
        {/* Today's row has the accent background: its details use the full text colour for contrast. */}
        <p
          className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-helper ${isToday ? "text-fg" : "text-fg-muted"}`}
        >
          <span className={row.overdue ? "font-semibold text-danger" : undefined}>
            {row.overdue ? t("overdueSince", { date: day }) : day}
            {isToday ? ` (${t("today")})` : ""}
          </span>
          {row.category ? (
            <LabelChip name={row.category.name} color={row.category.color} />
          ) : (
            <span>{t("uncategorized")}</span>
          )}
          <span>
            {row.minutes !== null ? t("minutes", { count: row.minutes }) : t("noEstimate")}
          </span>
          {row.kind === "recurring" ? <span>{t("repeats")}</span> : null}
          {row.requiresApproval ? <span>{t("approvalMark")}</span> : null}
          {lastDay ? <span>{t("poolClosesAfter", { date: lastDay })}</span> : null}
        </p>
      </div>
      {row.eligible ? (
        <ClaimButton occurrenceId={row.id} title={row.title} />
      ) : (
        <span className="text-helper font-medium text-fg-muted" data-testid="pool-not-eligible">
          {t("notEligible")}
        </span>
      )}
    </li>
  );
}

export interface ClaimButtonProps {
  readonly occurrenceId: string;
  readonly title: string;
  readonly variant?: "primary" | "secondary";
}

/**
 * Claims one occurrence in one step (S21, spec "instant claiming with brief Undo"). The page
 * re-reads afterwards; a toast offers Undo for a short while. A claim someone else won says so and
 * refreshes the list.
 */
export function ClaimButton({ occurrenceId, title, variant = "secondary" }: ClaimButtonProps) {
  const t = useTranslations("Chores");
  const toasts = useClaimToasts();
  const mutation = useChoreMutation(
    `chore-occurrence:${occurrenceId}`,
    () =>
      sendChoreRequest<ClaimResponse>(
        "POST",
        `${CHORE_OCCURRENCES_ENDPOINT}/${occurrenceId}/claim`,
        {},
      ),
    () => {
      toasts.claimed(occurrenceId, title);
    },
    {
      // A lost race or a changed chore: the list is stale, so it is read again.
      refreshOnError: (failure) => failure !== "network" && failure !== "failed",
      onError: toasts.failed,
    },
  );
  return (
    <HydrationGate>
      <Button
        size="sm"
        variant={variant}
        loading={mutation.busy}
        onClick={() => {
          mutation.mutate(undefined);
        }}
        aria-label={t("claimLabel", { title })}
        data-testid="chore-claim"
      >
        {t("claim")}
      </Button>
    </HydrationGate>
  );
}
