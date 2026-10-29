"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";

import {
  GOAL_LIMITS,
  goalPeriodStart,
  parseGoalQuantity,
  type GoalSeriesState,
} from "@madeora/domain/goals";
import {
  HABIT_QUANTITY,
  habitUnits,
  thousandthsToDecimal,
  toThousandths,
} from "@madeora/domain/habits";

import { QuantityField } from "@/components/habits/numeric-fields";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { useToast } from "@/components/ui/toast";
import {
  goalSeriesEndpoint,
  sendGoalRequest,
  type GoalSeriesDetail,
  type GoalSeriesPeriods,
  type GoalSeriesTargetImpact,
  type GoalSeriesTargetResult,
  type GoalSummary,
} from "@/goals/api";
import { goalKeys, goalsPath } from "@/goals/format";
import { updateSeriesSchema } from "@/goals/schema";
import { goalSeriesTargetImpactSchema } from "@/goals/shapes";
import { CUSTOM_UNIT, draftUnit, localizedDecimal } from "@/habits/tracking-draft";
import { memberNames, type MemberNames, type MemberOption } from "@/tasks/format";

import { DialogActions, Failure } from "./goal-dialogs";
import { useGoalMutation } from "./use-goal-mutation";
import { useGoalTexts } from "./use-goal-texts";

/** Read again this often while the page is visible (no Realtime for goals). */
const REFRESH_INTERVAL_MS = 60_000;

type DialogKind = "target" | "edit" | "stop" | "delete";

export interface GoalSeriesViewProps {
  readonly initialSeries: GoalSeriesDetail;
  readonly members: readonly MemberOption[];
  /** For a personal series: the zones to offer. */
  readonly timeZones: readonly string[];
}

function useSeriesDetail(initial: GoalSeriesDetail): GoalSeriesDetail {
  const query = useQuery<{ series: GoalSeriesDetail }>({
    queryKey: goalKeys.series(initial.id),
    queryFn: () => sendGoalRequest("GET", goalSeriesEndpoint(initial.id)),
    initialData: { series: initial },
    staleTime: 30_000,
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });
  return query.data.series;
}

const seriesEventKey = {
  created: "seriesEventCreated",
  edited: "seriesEventEdited",
  target_scheduled: "seriesEventTargetScheduled",
  paused: "seriesEventPaused",
  resumed: "seriesEventResumed",
  stopped: "seriesEventStopped",
  restored: "seriesEventRestored",
} as const;

/**
 * A recurring series' page (S30b): how it repeats, its state, the period running now, the target
 * schedule with Change target, Pause / Resume / Stop, Edit and Delete for goal managers, the period
 * history (total against each period's own target, outcome, corrected, achieved, needs review) and
 * the series' change log. Every change is checked again by the database.
 */
export function GoalSeriesView({ initialSeries, members, timeZones }: GoalSeriesViewProps) {
  const t = useTranslations("Goals");
  const names = memberNames(members);
  const texts = useGoalTexts();
  const series = useSeriesDetail(initialSeries);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const close = () => {
    setDialog(null);
  };
  const state = useGoalMutation(`goal-series:${series.id}`, (action: "pause" | "resume") =>
    sendGoalRequest("POST", goalSeriesEndpoint(series.id, "state"), {
      revision: series.revision,
      action,
    }),
  );
  const { actions } = series;
  const measurable = series.kind === "measurable";
  return (
    <div className="flex flex-col gap-8" data-testid="goal-series-detail">
      <div className="flex flex-col gap-2">
        <PageHeader title={series.title} />
        <p className="flex flex-wrap items-center gap-2 text-body text-fg">
          <span
            className="inline-flex items-center rounded-full border border-line px-2 font-medium"
            data-testid="goal-series-state"
          >
            {texts.seriesState(series.state)}
          </span>
          <span>
            {t("seriesRepeatLine", {
              frequency: texts.frequency(series.frequency),
              kind: measurable ? t("kindMeasurable") : t("kindCompletion"),
            })}
          </span>
          {series.frequency === "weekly" ? (
            <span>· {t("seriesWeekStartLine", { day: texts.weekStart(series.weekStart) })}</span>
          ) : null}
        </p>
        <p className="text-helper text-fg-muted">
          {t("seriesSinceLine", { date: texts.date(series.firstPeriodStart, "short") })}
          {series.endsOn
            ? ` · ${t("seriesEndsLine", { date: texts.date(series.endsOn, "short") })}`
            : ""}
        </p>
        {series.description ? (
          <p className="max-w-prose whitespace-pre-line text-body text-fg-muted">
            <bdi>{series.description}</bdi>
          </p>
        ) : null}
        {series.reminder ? (
          <p className="text-helper text-fg-muted">
            {t("seriesReminderLine", {
              days: series.reminder.leadDays,
              time: series.reminder.atTime,
            })}
          </p>
        ) : null}
      </div>

      <CurrentPeriod series={series} />

      {actions.manage ? (
        <div className="flex flex-wrap gap-2" data-testid="goal-series-actions">
          {actions.changeTarget ? (
            <Button
              variant="secondary"
              onClick={() => {
                setDialog("target");
              }}
              data-testid="goal-series-change-target"
            >
              {t("changeTarget")}
            </Button>
          ) : null}
          {actions.pause ? (
            <Button
              variant="secondary"
              loading={state.busy}
              onClick={() => {
                state.mutate("pause");
              }}
              data-testid="goal-series-pause"
            >
              {t("seriesPause")}
            </Button>
          ) : null}
          {actions.resume ? (
            <Button
              variant="secondary"
              loading={state.busy}
              onClick={() => {
                state.mutate("resume");
              }}
              data-testid="goal-series-resume"
            >
              {t("seriesResume")}
            </Button>
          ) : null}
          {series.state === "stopped" ? null : (
            <Button
              variant="secondary"
              onClick={() => {
                setDialog("edit");
              }}
              data-testid="goal-series-edit"
            >
              {t("edit")}
            </Button>
          )}
          {actions.stop ? (
            <Button
              variant="secondary"
              onClick={() => {
                setDialog("stop");
              }}
              data-testid="goal-series-stop"
            >
              {t("seriesStop")}
            </Button>
          ) : null}
          <Button
            variant="destructive"
            onClick={() => {
              setDialog("delete");
            }}
            data-testid="goal-series-delete"
          >
            {t("delete")}
          </Button>
        </div>
      ) : null}
      <Failure error={state.error} />

      {measurable ? <TargetSchedule series={series} /> : null}
      <PeriodHistory series={series} />
      <SeriesEvents series={series} names={names} />

      {dialog === "target" ? <SeriesTargetDialog series={series} onClose={close} /> : null}
      {dialog === "edit" ? (
        <SeriesEditDialog series={series} timeZones={timeZones} onClose={close} />
      ) : null}
      {dialog === "stop" ? <SeriesStopDialog series={series} onClose={close} /> : null}
      {dialog === "delete" ? <SeriesDeleteDialog series={series} onClose={close} /> : null}
    </div>
  );
}

function CurrentPeriod({ series }: { readonly series: GoalSeriesDetail }) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const current = series.current;
  return (
    <section aria-labelledby="goal-series-current-heading" className="flex flex-col gap-2">
      <h2 id="goal-series-current-heading" className="text-section-title font-semibold">
        {t("seriesCurrentTitle")}
      </h2>
      {current ? (
        <p className="text-body text-fg" data-testid="goal-series-current">
          <Link
            href={goalsPath(series.homeId, current.id)}
            className="font-medium text-accent-fg underline"
          >
            {texts.period(current.start, current.end)}
          </Link>{" "}
          · {series.kind === "measurable" ? texts.progress(current) : texts.status(current.status)}
        </p>
      ) : (
        <p className="text-body text-fg-muted" data-testid="goal-series-current">
          {noCurrentText(series.state, t)}
        </p>
      )}
    </section>
  );
}

function noCurrentText(state: GoalSeriesState, t: ReturnType<typeof useTranslations<"Goals">>) {
  if (state === "paused") return t("seriesNoCurrentPaused");
  if (state === "stopped") return t("seriesNoCurrentStopped");
  return t("seriesNoCurrent");
}

/** Which target applies from which period on; past rows stay as the history of earlier periods. */
function TargetSchedule({ series }: { readonly series: GoalSeriesDetail }) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  return (
    <section aria-labelledby="goal-series-targets-heading" className="flex flex-col gap-2">
      <h2 id="goal-series-targets-heading" className="text-section-title font-semibold">
        {t("seriesTargetsTitle")}
      </h2>
      <ul className="flex flex-col gap-1 text-body text-fg" data-testid="goal-series-targets">
        {series.targets.map((row) => (
          <li key={row.effectiveFrom} className={row.past ? "text-fg-muted" : undefined}>
            {t("seriesTargetRow", {
              date: texts.date(row.effectiveFrom, "short"),
              amount: texts.amount(row.target, row.unit, row.unitKind),
            })}
          </li>
        ))}
      </ul>
    </section>
  );
}

function usePeriodPages(series: GoalSeriesDetail) {
  return useInfiniteQuery({
    queryKey: goalKeys.seriesPeriods(series.id),
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      const search = pageParam ? `?before=${encodeURIComponent(pageParam)}` : "";
      const answer = await sendGoalRequest<{ periods: GoalSeriesPeriods }>(
        "GET",
        `${goalSeriesEndpoint(series.id, "periods")}${search}`,
      );
      return answer.periods;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last: GoalSeriesPeriods) =>
      last.hasMore ? (last.periods.at(-1)?.id ?? undefined) : undefined,
    refetchInterval: REFRESH_INTERVAL_MS,
  });
}

function PeriodRow({ period }: { readonly period: GoalSummary }) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const info = period.period;
  if (!info) return null;
  const marks = [
    info.outcome ? texts.outcome(info.outcome) : info.ended ? null : t("periodRunning"),
    info.correctedAt ? t("periodCorrected") : null,
    period.status === "achieved" ? t("statusAchieved") : null,
    info.needsReview ? t("needsReviewShort") : null,
  ].filter((mark): mark is string => mark !== null);
  return (
    <li className="flex flex-wrap items-baseline gap-x-2" data-testid="goal-series-period">
      <Link href={goalsPath(period.homeId, period.id)} className="text-accent-fg underline">
        {texts.period(info.start, info.end)}
      </Link>
      <span>
        {period.kind === "measurable" ? texts.progress(period) : texts.status(period.status)}
      </span>
      {marks.length > 0 ? <span className="text-fg-muted">· {marks.join(" · ")}</span> : null}
    </li>
  );
}

function PeriodHistory({ series }: { readonly series: GoalSeriesDetail }) {
  const t = useTranslations("Goals");
  const pages = usePeriodPages(series);
  const rows = pages.data?.pages.flatMap((page) => page.periods) ?? [];
  return (
    <section aria-labelledby="goal-series-periods-heading" className="flex flex-col gap-2">
      <h2 id="goal-series-periods-heading" className="text-section-title font-semibold">
        {t("seriesPeriodsTitle")}
      </h2>
      {pages.isError ? <p className="text-body text-danger">{t("historyFailed")}</p> : null}
      {pages.isSuccess && rows.length === 0 ? (
        <p className="text-body text-fg-muted">{t("seriesPeriodsEmpty")}</p>
      ) : null}
      <ul className="flex flex-col gap-1 text-body text-fg" data-testid="goal-series-periods">
        {rows.map((period) => (
          <PeriodRow key={period.id} period={period} />
        ))}
      </ul>
      {pages.hasNextPage ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            loading={pages.isFetchingNextPage}
            onClick={() => {
              void pages.fetchNextPage();
            }}
          >
            {t("showMore")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function SeriesEvents({
  series,
  names,
}: {
  readonly series: GoalSeriesDetail;
  readonly names: MemberNames;
}) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  return (
    <section aria-labelledby="goal-series-events-heading" className="flex flex-col gap-2">
      <h2 id="goal-series-events-heading" className="text-section-title font-semibold">
        {t("historyTitle")}
      </h2>
      <ul className="flex flex-col gap-1 text-body text-fg" data-testid="goal-series-events">
        {series.events.map((event) => (
          <li key={event.id}>
            {t(seriesEventKey[event.kind], {
              person: texts.who(event.by, event.mine, names),
              at: texts.instant(event.at, series.timeZone),
            })}
          </li>
        ))}
      </ul>
    </section>
  );
}

type TargetWhen = "current" | "next" | "later";

/**
 * Changes a measurable series' target and unit from a period on: the period running now, the next
 * one (the default) or a later one. Past periods keep theirs. A preview shows which periods use it
 * and, for the running period, its progress before and after; a unit change with progress or a
 * change of "target reached" must be confirmed.
 */
function SeriesTargetDialog({
  series,
  onClose,
}: {
  readonly series: GoalSeriesDetail;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const [when, setWhen] = useState<TargetWhen>(series.nextPeriod ? "next" : "current");
  const [laterDate, setLaterDate] = useState(series.nextPeriod?.start ?? series.today);
  const [target, setTarget] = useState(
    series.target === null ? "" : localizedDecimal(toThousandths(series.target), texts.locale),
  );
  const [unitCode, setUnitCode] = useState(
    series.unitKind === "custom" ? CUSTOM_UNIT : (series.unit ?? "pages"),
  );
  const [custom, setCustom] = useState(series.unitKind === "custom" ? (series.unit ?? "") : "");
  const [preview, setPreview] = useState<GoalSeriesTargetImpact | null>(null);
  const [confirmUnit, setConfirmUnit] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const unit = draftUnit({ unit: unitCode, custom });
  const send = useGoalMutation(
    `goal-series:${series.id}`,
    (body: object) =>
      sendGoalRequest<GoalSeriesTargetResult>(
        "POST",
        goalSeriesEndpoint(series.id, "target"),
        body,
      ),
    (result) => {
      if (result.outcome === "preview" || result.outcome === "unchanged") {
        setPreview(result.impact ?? null);
      } else {
        onClose();
      }
    },
  );
  const effectiveFrom =
    when === "current"
      ? series.currentPeriod.start
      : when === "next"
        ? (series.nextPeriod?.start ?? series.currentPeriod.start)
        : goalPeriodStart(series.frequency, series.weekStart, laterDate);
  const read = () => {
    if (!unit) {
      setError(t("fieldUnitRequired"));
      return null;
    }
    const parsed = parseGoalQuantity(target, texts.locale, unit);
    if (!parsed.ok) {
      setError(texts.numeric.problem(parsed.problem));
      return null;
    }
    setError(undefined);
    return {
      revision: series.revision,
      effectiveFrom,
      target: thousandthsToDecimal(parsed.thousandths),
      unit: unit.unit,
      unitKind: unit.kind,
    };
  };
  const refused =
    send.error && (send.error.failure === "confirmUnit" || send.error.failure === "confirmStatus")
      ? goalSeriesTargetImpactSchema.safeParse(send.error.details.impact)
      : null;
  const impact = refused?.success ? refused.data : preview;
  const needsUnit =
    impact?.current === true &&
    impact.unitChanged &&
    impact.total !== null &&
    toThousandths(impact.total) !== 0;
  const needsStatus =
    impact?.current === true && (impact.reachedBefore !== impact.reachedAfter || impact.reopens);
  const unitOptions = [
    ...habitUnits.map((definition) => ({
      value: definition.code,
      label: texts.numeric.unitOption(definition.code),
    })),
    { value: CUSTOM_UNIT, label: t("unitOptionCustom") },
  ];
  const whenOptions = [
    ...(series.current && series.current.start === series.currentPeriod.start
      ? [{ value: "current", label: t("seriesTargetWhenCurrent") }]
      : []),
    ...(series.nextPeriod ? [{ value: "next", label: t("seriesTargetWhenNext") }] : []),
    { value: "later", label: t("seriesTargetWhenLater") },
  ];
  const resetPreview = () => {
    setPreview(null);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("targetTitle")}
      description={t("seriesTargetExplanation")}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const body = read();
          if (body) send.mutate({ ...body, preview: true });
        }}
        data-testid="goal-series-target-form"
      >
        <SelectField
          label={t("seriesTargetWhen")}
          value={when}
          options={whenOptions}
          onChange={(event) => {
            setWhen(event.target.value as TargetWhen);
            resetPreview();
          }}
          data-testid="goal-series-target-when"
        />
        {when === "later" ? (
          <TextField
            label={t("seriesTargetLaterDate")}
            description={t("seriesTargetLaterHint", {
              period: texts.period(effectiveFrom, effectiveFrom),
            })}
            type="date"
            min={series.today}
            value={laterDate}
            onChange={(event) => {
              setLaterDate(event.target.value);
              resetPreview();
            }}
            data-testid="goal-series-target-date"
          />
        ) : null}
        <SelectField
          label={t("fieldUnit")}
          value={unitCode}
          options={unitOptions}
          onChange={(event) => {
            setUnitCode(event.target.value);
            resetPreview();
          }}
          data-testid="goal-series-target-unit"
        />
        {unitCode === CUSTOM_UNIT ? (
          <TextField
            label={t("fieldCustomUnit")}
            description={t("fieldCustomUnitHint", { max: HABIT_QUANTITY.customUnitLength })}
            value={custom}
            maxLength={HABIT_QUANTITY.customUnitLength * 2}
            autoComplete="off"
            onChange={(event) => {
              setCustom(event.target.value);
              resetPreview();
            }}
          />
        ) : null}
        <QuantityField
          label={t("fieldTarget")}
          value={target}
          unit={unit}
          limits={{ max: GOAL_LIMITS.max }}
          error={error}
          onChange={(text) => {
            setTarget(text);
            resetPreview();
          }}
          testId="goal-series-target-value"
        />
        {impact ? <SeriesImpactSummary impact={impact} /> : null}
        {needsUnit ? (
          <Checkbox
            label={t("confirmUnitLabel")}
            checked={confirmUnit}
            onChange={(event) => {
              setConfirmUnit(event.target.checked);
            }}
            data-testid="goal-series-confirm-unit"
          />
        ) : null}
        {needsStatus ? (
          <Checkbox
            label={t("confirmStatusLabel")}
            checked={confirmStatus}
            onChange={(event) => {
              setConfirmStatus(event.target.checked);
            }}
            data-testid="goal-series-confirm-status"
          />
        ) : null}
        <Failure
          error={
            send.error &&
            send.error.failure !== "confirmUnit" &&
            send.error.failure !== "confirmStatus"
              ? send.error
              : null
          }
        />
        <DialogActions onClose={onClose}>
          <Button type="submit" variant="secondary" loading={send.busy && !impact}>
            {t("preview")}
          </Button>
          {impact ? (
            <Button
              disabled={(needsUnit && !confirmUnit) || (needsStatus && !confirmStatus)}
              loading={send.busy}
              onClick={() => {
                const body = read();
                if (body) send.mutate({ ...body, confirmUnit, confirmStatus });
              }}
              data-testid="goal-series-target-save"
            >
              {t("save")}
            </Button>
          ) : null}
        </DialogActions>
      </form>
    </Dialog>
  );
}

function SeriesImpactSummary({ impact }: { readonly impact: GoalSeriesTargetImpact }) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const before = texts.amount(impact.targetBefore, impact.unitBefore, impact.unitKindBefore);
  const after = texts.amount(impact.targetAfter, impact.unitAfter, impact.unitKindAfter);
  return (
    <div className="flex flex-col gap-1 text-body text-fg" data-testid="goal-series-target-impact">
      <p>{t("seriesImpactTarget", { before, after })}</p>
      <p>
        {impact.until
          ? t("seriesImpactUntil", {
              from: texts.date(impact.effectiveFrom, "short"),
              until: texts.date(impact.until, "short"),
            })
          : t("seriesImpactOnward", { from: texts.date(impact.effectiveFrom, "short") })}
      </p>
      {impact.current && impact.total !== null ? (
        <p>
          {t("impactProgress", {
            before: texts.progress({
              total: impact.total,
              target: impact.targetBefore,
              unit: impact.unitBefore,
              unitKind: impact.unitKindBefore,
            }),
            after: texts.progress({
              total: impact.total,
              target: impact.targetAfter,
              unit: impact.unitAfter,
              unitKind: impact.unitKindAfter,
            }),
          })}
        </p>
      ) : null}
      {impact.current ? null : <p>{t("seriesImpactPastKept")}</p>}
      {impact.unitChanged && impact.current ? <p>{t("impactUnit")}</p> : null}
      {impact.reopens ? <p>{t("impactReopens")}</p> : null}
      {impact.achieved && !impact.reopens ? <p>{t("impactStaysAchieved")}</p> : null}
    </div>
  );
}

interface EditValues {
  title: string;
  description: string;
  endsOn: string;
  timeZone: string;
  leadDays: string;
  leadTime: string;
}

type EditField = "title" | "description" | "endsOn" | "timeZone" | "leadDays";
const editFields: readonly EditField[] = ["title", "description", "endsOn", "timeZone", "leadDays"];

function isEditField(value: unknown): value is EditField {
  return typeof value === "string" && (editFields as readonly string[]).includes(value);
}

/** Edits a series' title, description, end date, timezone and reminder, for later periods. */
function SeriesEditDialog({
  series,
  timeZones,
  onClose,
}: {
  readonly series: GoalSeriesDetail;
  readonly timeZones: readonly string[];
  readonly onClose: () => void;
}) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const personal = series.homeId === null;
  const form = useForm<EditValues>({
    defaultValues: {
      title: series.title,
      description: series.description ?? "",
      endsOn: series.endsOn ?? "",
      timeZone: series.timeZone,
      leadDays: series.reminder?.leadDays.toString() ?? "",
      leadTime: series.reminder?.atTime ?? "09:00",
    },
  });
  const errors = form.formState.errors;
  const save = useGoalMutation(
    `goal-series:${series.id}`,
    (body: object) => sendGoalRequest("PATCH", goalSeriesEndpoint(series.id), body),
    onClose,
  );
  const submit = (values: EditValues) => {
    form.clearErrors();
    const lead = values.leadDays.trim();
    const leadDays = lead === "" ? null : Number(lead);
    let first: EditField | null = null;
    if (
      leadDays !== null &&
      (!Number.isInteger(leadDays) || leadDays < 1 || leadDays > GOAL_LIMITS.leadDays)
    ) {
      form.setError("leadDays", { message: "invalid" });
      first = "leadDays";
    }
    const parsed = updateSeriesSchema.safeParse({
      revision: series.revision,
      title: values.title,
      description: values.description,
      endsOn: values.endsOn === "" ? null : values.endsOn,
      timeZone: personal ? values.timeZone : null,
      reminder: leadDays === null ? null : { leadDays, atTime: values.leadTime },
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (isEditField(field) && !form.getFieldState(field).error) {
          form.setError(field, { message: issue.message });
          first ??= field;
        }
      }
    }
    if (first) form.setFocus(first);
    if (!parsed.success || first) return;
    save.mutate(parsed.data);
  };
  const fieldError = (field: EditField) => {
    const message = errors[field]?.message;
    if (message === undefined) return undefined;
    return field === "leadDays" ? t("fieldSeriesLeadInvalid") : texts.field(message);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("seriesEditTitle")}
      description={t("seriesEditExplanation")}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void form.handleSubmit(submit)(event);
        }}
        data-testid="goal-series-edit-form"
      >
        <TextField
          label={t("fieldTitle")}
          autoComplete="off"
          error={fieldError("title")}
          {...form.register("title")}
          data-testid="goal-series-edit-title"
        />
        <TextArea
          label={t("fieldDescription")}
          rows={3}
          error={fieldError("description")}
          {...form.register("description")}
        />
        <TextField
          label={t("fieldEndsOn")}
          description={t("fieldEndsOnHint")}
          type="date"
          error={fieldError("endsOn")}
          {...form.register("endsOn")}
        />
        {personal ? (
          <SelectField
            label={t("fieldTimeZone")}
            options={timeZones.map((zone) => ({ value: zone, label: zone }))}
            error={fieldError("timeZone")}
            {...form.register("timeZone")}
          />
        ) : null}
        <TextField
          label={t("fieldSeriesLead")}
          description={t("fieldSeriesLeadHint", { max: GOAL_LIMITS.leadDays })}
          type="number"
          min={1}
          max={GOAL_LIMITS.leadDays}
          error={fieldError("leadDays")}
          {...form.register("leadDays")}
        />
        <TextField label={t("remindersAt")} type="time" {...form.register("leadTime")} />
        <Failure error={save.error} />
        <DialogActions onClose={onClose}>
          <Button type="submit" loading={save.busy} data-testid="goal-series-edit-save">
            {t("save")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Stops a series for good: no new periods; past and current periods stay. */
function SeriesStopDialog({
  series,
  onClose,
}: {
  readonly series: GoalSeriesDetail;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Goals");
  const stop = useGoalMutation(
    `goal-series:${series.id}`,
    () =>
      sendGoalRequest("POST", goalSeriesEndpoint(series.id, "state"), {
        revision: series.revision,
        action: "stop",
      }),
    onClose,
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("seriesStopTitle")}
      description={t("seriesStopExplanation", { series: series.title })}
      closeLabel={t("close")}
    >
      <div className="flex flex-col gap-4">
        <Failure error={stop.error} />
        <DialogActions onClose={onClose}>
          <Button
            variant="destructive"
            loading={stop.busy}
            onClick={() => {
              stop.mutate(undefined);
            }}
            data-testid="goal-series-stop-confirm"
          >
            {t("seriesStop")}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}

/** Moves a series and all its periods to the trash, restorable unchanged for 7 days. */
function SeriesDeleteDialog({
  series,
  onClose,
}: {
  readonly series: GoalSeriesDetail;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Goals");
  const router = useRouter();
  const toast = useToast();
  const remove = useGoalMutation(
    `goal-series:${series.id}`,
    () => sendGoalRequest("DELETE", goalSeriesEndpoint(series.id), { revision: series.revision }),
    () => {
      toast.show({ title: t("deletedToast", { goal: series.title }), tone: "info" });
      router.push(goalsPath(series.homeId));
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("seriesDeleteTitle")}
      description={t("seriesDeleteExplanation", { series: series.title })}
      closeLabel={t("close")}
    >
      <div className="flex flex-col gap-4">
        <Failure error={remove.error} />
        <DialogActions onClose={onClose}>
          <Button
            variant="destructive"
            loading={remove.busy}
            onClick={() => {
              remove.mutate(undefined);
            }}
            data-testid="goal-series-delete-confirm"
          >
            {t("delete")}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}
