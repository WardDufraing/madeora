"use client";

import { useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations, type DateTimeFormatOptions } from "next-intl";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { SelectField } from "@/components/ui/select-field";
import { isInternalPath, callOraTool, OraToolError } from "@/ora/tools/client";
import {
  defaultOverviewFilters,
  type Overview,
  type OverviewDay,
  type OverviewFilters,
  type OverviewItem,
  type OverviewModule,
  type OverviewRequest,
  type OverviewTarget,
} from "@/ora/overview/types";

import { OraOverviewShare } from "./ora-overview-share";
import type { OraStatus } from "./ora-content";

export interface OraOverviewProps {
  readonly userId: string;
  /** `null`: Personal space. */
  readonly homeId: string | null;
  /** The name of the Home, or "Personal": shown with the dates. */
  readonly contextName: string;
  readonly initialTarget: OverviewTarget;
  readonly onBack: () => void;
  readonly onNavigated: () => void;
  readonly onStatus: (status: OraStatus) => void;
}

const presets = ["today", "tomorrow", "this-week", "next-week"] as const;
const presetKey = {
  today: "today",
  tomorrow: "tomorrow",
  "this-week": "thisWeek",
  "next-week": "nextWeek",
} as const;

async function fetchOverview(homeId: string | null, request: OverviewRequest): Promise<Overview> {
  const output = await callOraTool(homeId, "overview", request);
  if (output.kind !== "overview") throw new OraToolError("unavailable");
  return output.overview;
}

/**
 * Ora's daily and weekly overview inside the shared bubble or sheet (S46). One standard format for
 * everyone: a compact summary per day and, on request, the related items (timed ones first, the
 * rest apart). Read-only: items open their own pages. It shows exactly what the server returned for
 * this person in this place, and asks again (never reuses an old answer) each time it is opened,
 * refreshed or its settings change. The parent remounts it for another Home or account.
 */
export function OraOverview({
  userId,
  homeId,
  contextName,
  initialTarget,
  onBack,
  onNavigated,
  onStatus,
}: OraOverviewProps) {
  const t = useTranslations("OraOverview");
  const [target, setTarget] = useState<OverviewTarget>(initialTarget);
  const [date, setDate] = useState<string | undefined>(undefined);
  const [filters, setFilters] = useState<OverviewFilters>(defaultOverviewFilters);
  const [showItems, setShowItems] = useState(false);

  const request = useMemo<OverviewRequest>(
    () => ({ target, ...(date ? { date } : {}), filters }),
    [target, date, filters],
  );

  const query = useQuery({
    queryKey: ["ora", "overview", userId, homeId ?? "personal", request],
    queryFn: () => fetchOverview(homeId, request),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const status: OraStatus = query.isFetching ? "working" : query.isError ? "problem" : "idle";
  useEffect(() => {
    onStatus(status);
  }, [status, onStatus]);

  const overview = query.data;
  const filtered =
    filters.modules.length > 0 || filters.assignee !== "anyone" || filters.completion !== "all";
  const pick = (next: OverviewTarget, nextDate?: string) => {
    setTarget(next);
    setDate(nextDate);
  };
  const [pickedDate, setPickedDate] = useState("");

  return (
    <div className="flex flex-col gap-4" data-testid="ora-overview">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-body font-semibold">{t("title")}</h3>
        <Button variant="ghost" size="sm" onClick={onBack}>
          {t("back")}
        </Button>
      </div>

      <div role="group" aria-label={t("periodLabel")} className="flex flex-col gap-2">
        <ul className="flex flex-wrap gap-2">
          {presets.map((preset) => (
            <li key={preset}>
              <ToggleButton
                pressed={target === preset}
                onClick={() => {
                  pick(preset);
                }}
              >
                {t(`presets.${presetKey[preset]}`)}
              </ToggleButton>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-helper">
            <span className="font-medium">{t("pickDate")}</span>
            <input
              type="date"
              value={pickedDate}
              onChange={(event) => {
                setPickedDate(event.currentTarget.value);
              }}
              className="min-h-8 rounded-control border border-line-control bg-surface px-2 text-helper text-fg"
            />
          </label>
          <ToggleButton
            pressed={target === "day" && date === pickedDate}
            disabled={pickedDate === ""}
            onClick={() => {
              pick("day", pickedDate);
            }}
          >
            {t("thatDay")}
          </ToggleButton>
          <ToggleButton
            pressed={target === "week" && date === pickedDate}
            disabled={pickedDate === ""}
            onClick={() => {
              pick("week", pickedDate);
            }}
          >
            {t("thatWeek")}
          </ToggleButton>
        </div>
      </div>

      {overview ? (
        <OverviewFiltersBar
          overview={overview}
          filters={filters}
          homeId={homeId}
          onChange={setFilters}
        />
      ) : null}

      <div aria-live="polite" aria-busy={query.isFetching}>
        {query.isError ? (
          <div role="alert" className="flex flex-col gap-2" data-testid="ora-overview-failed">
            <p className="text-helper text-danger">
              {query.error instanceof OraToolError && query.error.failure === "forbidden"
                ? t("forbidden")
                : t("failed")}
            </p>
            <div>
              <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>
                {t("retry")}
              </Button>
            </div>
          </div>
        ) : query.isPending ? (
          <p className="text-helper text-fg-muted">{t("loading")}</p>
        ) : null}
        {overview ? (
          <OverviewBody
            overview={overview}
            homeId={homeId}
            contextName={contextName}
            filtered={filtered}
            showItems={showItems}
            onToggleItems={() => {
              setShowItems((value) => !value);
            }}
            onNavigated={onNavigated}
            onRefresh={() => void query.refetch()}
            refreshing={query.isFetching}
          />
        ) : null}
      </div>

      {overview && homeId !== null ? (
        <OraOverviewShare homeId={homeId} request={request} overview={overview} />
      ) : null}
    </div>
  );
}

function ToggleButton({
  pressed,
  onClick,
  disabled,
  children,
}: {
  readonly pressed: boolean;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "inline-flex min-h-8 items-center rounded-control border px-3 text-helper disabled:opacity-50",
        pressed
          ? "border-accent bg-accent-subtle font-semibold text-fg"
          : "border-line-control bg-surface text-fg hover:bg-accent-subtle",
      )}
    >
      {children}
    </button>
  );
}

function OverviewFiltersBar({
  overview,
  filters,
  homeId,
  onChange,
}: {
  readonly overview: Overview;
  readonly filters: OverviewFilters;
  readonly homeId: string | null;
  readonly onChange: (filters: OverviewFilters) => void;
}) {
  const t = useTranslations("OraOverview");
  const active =
    filters.modules.length > 0 || filters.assignee !== "anyone" || filters.completion !== "all";
  const others = overview.members.filter((member) => !member.isSelf);
  const toggle = (module: OverviewModule) => {
    const next = filters.modules.includes(module)
      ? filters.modules.filter((value) => value !== module)
      : [...filters.modules, module];
    onChange({ ...filters, modules: next });
  };
  return (
    <section aria-label={t("filtersTitle")} className="flex flex-col gap-2">
      <h4 className="text-helper font-semibold text-fg-muted">{t("filtersTitle")}</h4>
      <ul className="flex flex-wrap gap-2">
        {overview.modules.length > 1
          ? overview.modules.map((module) => (
              <li key={module}>
                <ToggleButton
                  pressed={filters.modules.includes(module)}
                  onClick={() => {
                    toggle(module);
                  }}
                >
                  {t(`modules.${module}`)}
                </ToggleButton>
              </li>
            ))
          : null}
        {homeId !== null ? (
          <li>
            <ToggleButton
              pressed={filters.assignee === "me"}
              onClick={() => {
                onChange({
                  ...filters,
                  assignee: filters.assignee === "me" ? "anyone" : "me",
                  member: undefined,
                });
              }}
            >
              {t("assigneeMe")}
            </ToggleButton>
          </li>
        ) : null}
        {(["open", "done"] as const).map((value) => (
          <li key={value}>
            <ToggleButton
              pressed={filters.completion === value}
              onClick={() => {
                onChange({ ...filters, completion: filters.completion === value ? "all" : value });
              }}
            >
              {t(`completion.${value}`)}
            </ToggleButton>
          </li>
        ))}
      </ul>
      {homeId !== null && others.length > 0 ? (
        <SelectField
          label={t("assigneeMember")}
          value={filters.assignee === "member" ? (filters.member ?? "") : ""}
          options={[
            { value: "", label: t("assigneeAnyone") },
            ...others.map((member) => ({ value: member.id, label: member.name ?? t("noName") })),
          ]}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onChange(
              value === ""
                ? { ...filters, assignee: "anyone", member: undefined }
                : { ...filters, assignee: "member", member: value },
            );
          }}
        />
      ) : null}
      {active ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onChange(defaultOverviewFilters);
            }}
          >
            {t("clearFilters")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function OverviewBody({
  overview,
  homeId,
  contextName,
  filtered,
  showItems,
  onToggleItems,
  onNavigated,
  onRefresh,
  refreshing,
}: {
  readonly overview: Overview;
  readonly homeId: string | null;
  readonly contextName: string;
  readonly filtered: boolean;
  readonly showItems: boolean;
  readonly onToggleItems: () => void;
  readonly onNavigated: () => void;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
}) {
  const t = useTranslations("OraOverview");
  const format = useFormatter();
  const day = (date: string, options: DateTimeFormatOptions) =>
    format.dateTime(new Date(`${date}T00:00:00Z`), { ...options, timeZone: "UTC" });
  const context = contextName;
  const range =
    overview.scope === "day"
      ? t("rangeDay", { date: day(overview.from, { dateStyle: "full" }), context })
      : t("rangeWeek", {
          from: day(overview.from, { dateStyle: "medium" }),
          to: day(overview.to, { dateStyle: "medium" }),
          context,
        });
  const busier = overview.days.filter((entry) => entry.busier);

  return (
    <div className="flex flex-col gap-3" data-testid="ora-overview-body">
      <p className="text-helper font-medium" data-testid="ora-overview-range">
        {range}
      </p>

      {overview.notices.length > 0 || overview.truncated ? (
        <div
          role="status"
          className="flex flex-col gap-1 rounded-card border border-line bg-accent-subtle p-3 text-helper"
          data-testid="ora-overview-notices"
        >
          <p className="font-semibold">{t("incompleteTitle")}</p>
          <ul className="list-disc ps-5">
            {overview.notices.map((notice, index) => (
              <li key={`${notice.module}-${notice.source ?? ""}-${String(index)}`}>
                <NoticeText notice={notice} />
              </li>
            ))}
            {overview.truncated ? <li>{t("notices.truncated")}</li> : null}
          </ul>
          <div>
            <Button variant="secondary" size="sm" loading={refreshing} onClick={onRefresh}>
              {t("retry")}
            </Button>
          </div>
        </div>
      ) : null}

      {filtered ? <p className="text-helper text-fg-muted">{t("subset")}</p> : null}

      {overview.empty !== null ? (
        <EmptyOverview overview={overview} homeId={homeId} onNavigated={onNavigated} />
      ) : (
        <>
          {busier.length > 0 ? (
            <p className="text-helper" data-testid="ora-overview-busier">
              {t("busier", {
                count: busier.length,
                days: format.list(
                  busier.map((entry) => day(entry.date, { weekday: "long" })),
                  { type: "conjunction" },
                ),
              })}
            </p>
          ) : null}
          <ul className="flex flex-col gap-2">
            {overview.days.map((entry) => (
              <li key={entry.date} className="text-helper">
                <span className="font-medium">
                  {day(entry.date, { weekday: "long", day: "numeric", month: "short" })}
                </span>
                {": "}
                <DaySummary entry={entry} incomplete={overview.incomplete} />
              </li>
            ))}
          </ul>
          <div>
            <button
              type="button"
              aria-expanded={showItems}
              aria-controls="ora-overview-items"
              onClick={onToggleItems}
              className="inline-flex min-h-8 items-center rounded-control text-helper font-medium text-accent-fg hover:underline"
            >
              {showItems ? t("hideItems") : t("showItems")}
            </button>
            {showItems ? (
              <div id="ora-overview-items" className="mt-2 flex flex-col gap-3">
                {overview.days
                  .filter((entry) => entry.timed.length + entry.untimed.length > 0)
                  .map((entry) => (
                    <DayItems
                      key={entry.date}
                      entry={entry}
                      heading={day(entry.date, {
                        weekday: "long",
                        day: "numeric",
                        month: "short",
                      })}
                      onNavigated={onNavigated}
                    />
                  ))}
                {overview.incomplete ? (
                  <p className="text-helper text-fg-muted">{t("itemsIncomplete")}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function NoticeText({ notice }: { readonly notice: Overview["notices"][number] }) {
  const t = useTranslations("OraOverview");
  const format = useFormatter();
  if (notice.kind === "unavailable") {
    return <>{t("notices.unavailable", { module: t(`modules.${notice.module}`) })}</>;
  }
  const source = notice.source ?? t("notices.googleCalendar");
  if (notice.lastSyncedAt === null) return <>{t("notices.unverified", { source })}</>;
  return (
    <>
      {t("notices.stale", {
        source,
        time: format.dateTime(new Date(notice.lastSyncedAt), {
          dateStyle: "medium",
          timeStyle: "short",
        }),
      })}
    </>
  );
}

function DaySummary({
  entry,
  incomplete,
}: {
  readonly entry: OverviewDay;
  readonly incomplete: boolean;
}) {
  const t = useTranslations("OraOverview");
  const format = useFormatter();
  const parts = (["calendar", "tasks", "chores"] as const)
    .filter((module) => entry.counts[module] > 0)
    .map((module) => t(`counts.${module}`, { count: entry.counts[module] }));
  if (parts.length === 0) return <>{incomplete ? t("nothingIncomplete") : t("nothingDay")}</>;
  return <>{format.list(parts, { type: "unit" })}</>;
}

function DayItems({
  entry,
  heading,
  onNavigated,
}: {
  readonly entry: OverviewDay;
  readonly heading: string;
  readonly onNavigated: () => void;
}) {
  const t = useTranslations("OraOverview");
  return (
    <section aria-label={heading} className="flex flex-col gap-1.5">
      <h4 className="text-helper font-semibold text-fg-muted">{heading}</h4>
      {entry.timed.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {entry.timed.map((item) => (
            <ItemRow key={item.key} item={item} onNavigated={onNavigated} />
          ))}
        </ul>
      ) : null}
      {entry.untimed.length > 0 ? (
        <>
          {entry.timed.length > 0 ? (
            <p className="text-helper text-fg-muted">{t("noSetTime")}</p>
          ) : null}
          <ul className="flex flex-col gap-1.5">
            {entry.untimed.map((item) => (
              <ItemRow key={item.key} item={item} onNavigated={onNavigated} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function ItemRow({
  item,
  onNavigated,
}: {
  readonly item: OverviewItem;
  readonly onNavigated: () => void;
}) {
  const t = useTranslations("OraOverview");
  const format = useFormatter();
  const safe = isInternalPath(item.href);
  const time =
    item.startsAt !== null
      ? format.dateTime(new Date(item.startsAt), {
          hour: "numeric",
          minute: "2-digit",
          timeZone: item.timeZone,
        })
      : item.module === "calendar"
        ? t("allDay")
        : null;
  return (
    <li className="flex flex-col gap-0.5 rounded-control border border-line px-2 py-1.5 text-helper">
      <span className="flex flex-wrap items-baseline gap-x-2">
        {time ? <span className="font-medium tabular-nums">{time}</span> : null}
        {safe ? (
          <Link
            href={item.href}
            onClick={onNavigated}
            className={cx("underline", item.status === "done" && "line-through")}
          >
            {item.title}
          </Link>
        ) : (
          <span>{item.title}</span>
        )}
      </span>
      <span className="text-fg-muted">
        {t(`modules.${item.module}`)}
        {item.status !== "open" ? ` · ${t(`status.${item.status}`)}` : ""}
        {item.origin === "shared" ? ` · ${t("origin.shared")}` : ""}
        {item.origin === "google" ? ` · ${t("origin.google")}` : ""}
      </span>
      {item.canComplete && safe ? (
        <Link
          href={item.href}
          onClick={onNavigated}
          className="w-fit text-accent-fg underline"
          aria-label={t("completeIn", { title: item.title })}
        >
          {t("completeInShort")}
        </Link>
      ) : null}
    </li>
  );
}

function EmptyOverview({
  overview,
  homeId,
  onNavigated,
}: {
  readonly overview: Overview;
  readonly homeId: string | null;
  readonly onNavigated: () => void;
}) {
  const t = useTranslations("OraOverview");
  const empty = overview.empty ?? "none";
  const links = (
    [
      ["calendar", homeId === null ? "/calendar" : `/homes/${homeId}/calendar`],
      ["tasks", homeId === null ? "/tasks" : `/homes/${homeId}/tasks`],
    ] as const
  )
    .filter(([module]) => overview.modules.includes(module))
    .slice(0, 2);
  return (
    <div className="flex flex-col gap-2" data-testid="ora-overview-empty">
      <p className="text-helper">{t(`empty.${empty}`)}</p>
      {empty !== "filtered" && links.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {links.map(([module, href]) => (
            <li key={module}>
              <Link
                href={href}
                onClick={onNavigated}
                className="inline-flex min-h-8 items-center rounded-control border border-line-control px-3 text-helper text-fg hover:bg-accent-subtle"
              >
                {t(`openModule.${module}`)}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
