"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import type { ChoreRequestError } from "@/chores/api";
import { CHORES_ENDPOINT, sendChoreRequest, type ChoreHistoryPage } from "@/chores/api";
import { choreKeys, choresPath } from "@/chores/format";
import { CHORE_LIMITS, historyFilters, type HistoryFilter } from "@/chores/schema";
import type { DateTimeFormats } from "@/invitations/format";
import { formatTaskDate, memberNames, type MemberOption } from "@/tasks/format";

import { useHistoryLine } from "./history-line";
import { useChoreTexts } from "./use-chore-texts";

export interface ChoreHistoryProps {
  readonly userId: string;
  readonly homeId: string;
  readonly choreId: string;
  /** The first page of "all", read with the page. */
  readonly initial: ChoreHistoryPage;
  readonly loadedAt: string;
  readonly members: readonly MemberOption[];
  readonly formats: DateTimeFormats;
}

const filterKey = {
  all: "historyAll",
  completed: "historyCompleted",
  skipped: "historySkipped",
  missed: "historyMissed",
  pending_approval: "historyPending",
  rework: "historyRework",
} as const satisfies Record<HistoryFilter, string>;

/**
 * The chore's history (S20; spec "searchable Home-wide chore completion history": the individual
 * history), newest first, 50 at a time: completed (who did it, who recorded it, the note), skipped
 * (who, why), missed and today's. Every member of the Home reads it; nobody else.
 */
export function ChoreHistory({
  userId,
  homeId,
  choreId,
  initial,
  loadedAt,
  members,
  formats,
}: ChoreHistoryProps) {
  const t = useTranslations("Chores");
  const names = useMemo(() => memberNames(members), [members]);
  const texts = useChoreTexts(names);
  const line = useHistoryLine(names, formats);
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const query = useInfiniteQuery<ChoreHistoryPage, ChoreRequestError>({
    queryKey: choreKeys.history(userId, choreId, filter, loadedAt),
    queryFn: ({ pageParam }) =>
      sendChoreRequest<ChoreHistoryPage>(
        "GET",
        `${CHORES_ENDPOINT}/${choreId}/history?filter=${filter}&offset=${String(pageParam)}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (last) => {
      const next = last.offset + last.rows.length;
      return next < last.total && next <= CHORE_LIMITS.maxOffset ? next : undefined;
    },
    ...(filter === "all" ? { initialData: { pages: [initial], pageParams: [0] } } : {}),
    staleTime: Infinity,
  });
  const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;

  return (
    <section aria-labelledby="chore-history-heading" className="flex flex-col gap-3">
      <HydrationGate>
        <h2 id="chore-history-heading" className="text-section-title font-semibold text-fg">
          {t("historyHeading")}
        </h2>
        <SelectField
          label={t("historyFilter")}
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value as HistoryFilter);
          }}
          options={historyFilters.map((value) => ({ value, label: t(filterKey[value]) }))}
          className="max-w-60"
          data-testid="chore-history-filter"
        />
        <p className="text-helper text-fg-muted" aria-live="polite">
          {query.isPending ? t("historyLoading") : t("historyCount", { count: total })}
        </p>
        {rows.length > 0 ? (
          <ol
            className="flex flex-col divide-y divide-line rounded-card border border-line"
            data-testid="chore-history"
          >
            {rows.map((row) => (
              <li key={row.id} className="flex flex-col gap-0.5 p-3 text-body">
                <Link
                  href={`${choresPath(homeId)}/${row.id}`}
                  className="font-medium text-fg underline-offset-2 hover:underline"
                >
                  {formatTaskDate(row.scheduledDate, formats)} <bdi>{row.title}</bdi>
                </Link>
                <span className={row.status === "missed" ? "font-semibold text-danger" : "text-fg"}>
                  {line(row)}
                </span>
                {row.note ? (
                  <span className="break-words text-fg-muted">
                    {t("noteLabel")} {row.note}
                  </span>
                ) : null}
                {row.skipReason ? (
                  <span className="break-words text-fg-muted">
                    {t("reasonLabel")} {row.skipReason}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
        {query.error ? (
          <FormAlert tone="error" announce>
            {texts.failure(query.error.failure)}
          </FormAlert>
        ) : null}
        {query.hasNextPage ? (
          <div>
            <Button
              variant="secondary"
              loading={query.isFetchingNextPage}
              onClick={() => {
                void query.fetchNextPage();
              }}
            >
              {t("showMore")}
            </Button>
          </div>
        ) : null}
      </HydrationGate>
    </section>
  );
}
