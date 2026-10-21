"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { LabelChip } from "@/components/tasks/label-chip";
import { Button } from "@/components/ui/button";
import {
  CHORE_HISTORY_ENDPOINT,
  sendChoreRequest,
  type ChoreRequestError,
  type HomeHistoryPage,
} from "@/chores/api";
import { choreKeys, choresPath } from "@/chores/format";
import { CHORE_LIMITS, homeHistorySearch } from "@/chores/schema";
import type { DateTimeFormats } from "@/invitations/format";
import { formatTaskDate, memberNames, type MemberOption } from "@/tasks/format";

import { useHistoryLine } from "./history-line";
import { useChoreTexts } from "./use-chore-texts";

export interface HomeHistoryListProps {
  readonly userId: string;
  readonly homeId: string;
  /** The first page for the page's query, read with the page. */
  readonly initial: HomeHistoryPage;
  readonly loadedAt: string;
  readonly members: readonly MemberOption[];
  readonly formats: DateTimeFormats;
}

/**
 * The rows of a Home's chore history (S20), 50 at a time, newest first, each linking to its
 * occurrence: the chore, its scheduled and due date, the assignees, the outcome with who did,
 * recorded, skipped or approved it, attempts and rejections, the note or skip reason.
 */
export function HomeHistoryList({
  userId,
  homeId,
  initial,
  loadedAt,
  members,
  formats,
}: HomeHistoryListProps) {
  const t = useTranslations("Chores");
  const names = useMemo(() => memberNames(members), [members]);
  const texts = useChoreTexts(names);
  const line = useHistoryLine(names, formats);
  const search = homeHistorySearch(initial.query);
  const query = useInfiniteQuery<HomeHistoryPage, ChoreRequestError>({
    queryKey: choreKeys.homeHistory(userId, homeId, search, loadedAt),
    queryFn: ({ pageParam }) =>
      sendChoreRequest<HomeHistoryPage>(
        "GET",
        `${CHORE_HISTORY_ENDPOINT}?homeId=${homeId}${search ? `&${search}` : ""}&offset=${String(pageParam)}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (last) => {
      const next = last.offset + last.rows.length;
      return next < last.total && next <= CHORE_LIMITS.maxOffset ? next : undefined;
    },
    initialData: { pages: [initial], pageParams: [0] },
    staleTime: Infinity,
  });
  const rows = query.data.pages.flatMap((page) => page.rows);
  const base = choresPath(homeId);

  return (
    <HydrationGate>
      <ol
        className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface"
        data-testid="home-chore-history"
      >
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex flex-col gap-1 p-3 text-body"
            data-testid="home-history-row"
          >
            <Link
              href={`${base}/${row.id}`}
              className="font-semibold text-fg underline-offset-2 hover:underline"
            >
              <bdi>{row.title}</bdi>
            </Link>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-helper text-fg-muted">
              {row.category ? (
                <LabelChip name={row.category} color={row.categoryColor} />
              ) : (
                <span>{t("uncategorized")}</span>
              )}
              <span>{t("scheduledOn", { date: formatTaskDate(row.scheduledDate, formats) })}</span>
              {row.dueDate !== row.scheduledDate ? (
                <span>{t("dueOn", { date: formatTaskDate(row.dueDate, formats) })}</span>
              ) : null}
              <span>
                {row.assigneeIds.length === 0
                  ? t("unassigned")
                  : row.assigneeIds.map((id) => texts.member(id)).join(", ")}
              </span>
              {row.attempts > 0 ? (
                <span>{t("historyAttempts", { count: row.attempts, rejected: row.rejected })}</span>
              ) : null}
            </p>
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
            data-testid="home-history-more"
          >
            {t("showMore")}
          </Button>
        </div>
      ) : null}
    </HydrationGate>
  );
}
