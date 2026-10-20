"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { formatDateTime, type DateTimeFormats } from "@/invitations/format";
import {
  sendTaskRequest,
  TASKS_ENDPOINT,
  type OccurrencePage,
  type OccurrenceRow,
  type OccurrenceStatus,
  type RevisionResponse,
  type SeriesChangeResponse,
  type TaskDetail,
  type TaskSeries,
} from "@/tasks/api";
import {
  formatTaskDate,
  memberNames,
  taskKeys,
  tasksPath,
  type MemberOption,
} from "@/tasks/format";
import {
  dateOnlySchema,
  occurrenceFilters,
  type OccurrenceFilter,
  type RecurrenceInput,
  type SeriesScope,
} from "@/tasks/schema";

import { HydrationGate } from "./hydration-gate";
import {
  repeatDraftOf,
  RepeatFields,
  repeatSchema,
  ruleOf,
  useRecurrenceText,
  type RepeatError,
} from "./repeat-fields";
import { sendSeriesChange, SeriesScopeDialog, type OccurrenceScope } from "./series-scope";
import { useTaskMutation } from "./use-task-mutation";
import { useTaskTexts } from "./use-task-texts";

export interface TaskRepeatsProps {
  readonly userId: string;
  readonly task: TaskDetail & { readonly series: TaskSeries };
  readonly history: OccurrencePage;
  readonly loadedAt: string;
  readonly members: readonly MemberOption[];
  readonly formats: DateTimeFormats;
}

/**
 * The series an occurrence belongs to (S19): its schedule in plain words, the next date, whether it
 * is paused or ended, and for its creator and task managers Pause/Resume and Edit schedule. Below
 * it, the history of the series' occurrences: each scheduled date with its status and who actually
 * completed it.
 */
export function TaskRepeats({
  userId,
  task,
  history,
  loadedAt,
  members,
  formats,
}: TaskRepeatsProps) {
  const t = useTranslations("Tasks");
  const names = useMemo(() => memberNames(members), [members]);
  const texts = useTaskTexts(names);
  const text = useRecurrenceText(formats.dateFormat);
  const router = useRouter();
  const series = task.series;
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<RecurrenceInput | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const { announce, region } = useAnnouncer();

  const pause = useTaskMutation(
    `task:${task.id}:series`,
    (paused: boolean) =>
      sendTaskRequest<RevisionResponse>("PUT", `${TASKS_ENDPOINT}/${task.id}/series/paused`, {
        paused,
        expectedSeriesRevision: series.revision,
      }),
    (_result, paused) => {
      announce(paused ? t("announceSeriesPaused") : t("announceSeriesResumed"));
      statusRef.current?.focus();
    },
  );
  const schedule = useTaskMutation(
    `task:${task.id}:series`,
    ({ scope, rule }: { readonly scope: SeriesScope; readonly rule: RecurrenceInput }) =>
      sendSeriesChange(task.id, scope, scheduleBody(rule), false),
    (result: SeriesChangeResponse) => {
      setPending(null);
      setEditing(false);
      announce(t("announceScheduleSaved"));
      if (result.taskId !== task.id) {
        // The new schedule no longer has this occurrence: show the next one, or the list.
        router.push(
          result.taskId
            ? `${tasksPath(task.homeId)}/${result.taskId}`
            : `${tasksPath(task.homeId)}?list=${task.list.id}`,
        );
      } else {
        requestAnimationFrame(() => editButton.current?.focus());
      }
    },
  );

  function scheduleBody(rule: RecurrenceInput) {
    return {
      expectedTaskRevision: task.revision,
      expectedSeriesRevision: series.revision,
      schedule: rule,
    };
  }

  const rule = ruleOf(
    {
      frequency: series.frequency,
      interval: series.interval,
      weekdays: series.weekdays ? [...series.weekdays] : null,
      endsOn: series.endsOn,
      count: series.count,
    },
    series.startsOn,
  );
  const state = series.paused
    ? t("seriesPaused")
    : series.ended || series.nextDate === null
      ? t("seriesEnded")
      : t("seriesNext", { date: text.date(series.nextDate) });

  return (
    <section aria-labelledby="task-repeats-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2 id="task-repeats-heading" className="text-section-title font-semibold text-fg">
          {t("repeatsHeading")}
        </h2>
        <p className="text-body font-medium text-fg" data-testid="series-summary">
          {rule ? text.rule(rule) : t("repeatsUnknown")}
        </p>
        <p
          ref={statusRef}
          tabIndex={-1}
          className="text-body text-fg outline-none"
          data-testid="series-state"
        >
          {state}
        </p>
        {task.occurrenceDate ? (
          <p className="text-helper text-fg-muted">
            {t("occurrenceOf", { date: text.date(task.occurrenceDate) })}
          </p>
        ) : null}
        {series.detached ? (
          <p className="text-helper text-fg-muted">{t("occurrenceDetached")}</p>
        ) : null}
        {series.needsReassignment ? (
          <p className="font-semibold text-warning">{t("seriesNeedsReassignment")}</p>
        ) : null}
        {series.can.edit && !editing ? (
          <div className="flex flex-wrap gap-2">
            {!series.ended || series.paused ? (
              <Button
                variant="secondary"
                loading={pause.busy}
                onClick={() => {
                  pause.mutate(!series.paused);
                }}
                data-testid="series-pause"
              >
                {series.paused ? t("seriesResume") : t("seriesPause")}
              </Button>
            ) : null}
            <Button
              ref={editButton}
              variant="secondary"
              onClick={() => {
                setEditing(true);
              }}
              data-testid="series-edit-schedule"
            >
              {t("editSchedule")}
            </Button>
          </div>
        ) : null}
        {pause.error ? (
          <FormAlert tone="error" announce>
            {texts.failure(pause.error.failure)}
          </FormAlert>
        ) : null}
        {editing ? (
          <ScheduleForm
            series={series}
            dateFormat={formats.dateFormat}
            busy={schedule.busy}
            onCancel={() => {
              setEditing(false);
              schedule.reset();
              requestAnimationFrame(() => editButton.current?.focus());
            }}
            onSubmit={setPending}
          />
        ) : null}
        {pending ? (
          <SeriesScopeDialog
            open
            onClose={() => {
              setPending(null);
              schedule.reset();
            }}
            task={task}
            title={t("scopeScheduleTitle")}
            request={{ kind: "change", body: scheduleBody(pending) }}
            allowThis={false}
            allowSeries
            confirmLabel={t("save")}
            busy={schedule.busy}
            dateFormat={formats.dateFormat}
            onConfirm={(scope: OccurrenceScope) => {
              if (scope !== "this") schedule.mutate({ scope, rule: pending });
            }}
            error={schedule.error}
          />
        ) : null}
        <History
          userId={userId}
          task={task}
          initial={history}
          loadedAt={loadedAt}
          formats={formats}
          person={texts.person}
        />
      </HydrationGate>
    </section>
  );
}

const scheduleSchema = z
  .object({ startsOn: dateOnlySchema, repeat: repeatSchema })
  .refine((value) => value.repeat?.endsOn == null || value.repeat.endsOn >= value.startsOn, {
    message: "endsOn" satisfies RepeatError,
    path: ["repeat", "endsOn"],
  });

function ScheduleForm({
  series,
  dateFormat,
  busy,
  onCancel,
  onSubmit,
}: {
  readonly series: TaskSeries;
  readonly dateFormat: DateTimeFormats["dateFormat"];
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (rule: RecurrenceInput) => void;
}) {
  const t = useTranslations("Tasks");
  const form = useForm<z.input<typeof scheduleSchema>, unknown, z.output<typeof scheduleSchema>>({
    resolver: zodResolver(scheduleSchema),
    defaultValues: { startsOn: series.startsOn, repeat: repeatDraftOf(series) },
  });
  const errors = form.formState.errors;
  const startsOn = useWatch({ control: form.control, name: "startsOn" });

  return (
    <form
      noValidate
      className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
      data-testid="series-schedule-form"
      onSubmit={(event) => {
        void form.handleSubmit(({ startsOn: first, repeat }) => {
          if (repeat) onSubmit({ ...repeat, startsOn: first });
        })(event);
      }}
    >
      <TextField
        type="date"
        label={t("scheduleStartsOn")}
        description={t("scheduleStartsOnHelp")}
        error={errors.startsOn ? t("fieldInvalid") : undefined}
        {...form.register("startsOn")}
      />
      <Controller
        control={form.control}
        name="repeat"
        render={({ field }) => (
          <RepeatFields
            value={field.value}
            onChange={field.onChange}
            startsOn={dateOnlySchema.safeParse(startsOn).success ? startsOn : null}
            errors={{
              interval: errors.repeat?.interval?.message,
              weekdays: errors.repeat?.weekdays?.message ?? errors.repeat?.weekdays?.root?.message,
              endsOn: errors.repeat?.endsOn?.message,
              count: errors.repeat?.count?.message,
            }}
            dateFormat={dateFormat}
            allowNone={false}
          />
        )}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy} data-testid="series-schedule-save">
          {t("save")}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}

const statusKey = {
  completed: "historyCompleted",
  completed_late: "historyCompletedLate",
  missed: "historyMissed",
  open: "historyOpen",
} as const satisfies Record<OccurrenceStatus, string>;

const filterKey = {
  all: "historyFilterAll",
  completed: "historyFilterCompleted",
  missed: "historyFilterMissed",
} as const satisfies Record<OccurrenceFilter, string>;

function History({
  userId,
  task,
  initial,
  loadedAt,
  formats,
  person,
}: {
  readonly userId: string;
  readonly task: TaskDetail;
  readonly initial: OccurrencePage;
  readonly loadedAt: string;
  readonly formats: DateTimeFormats;
  readonly person: (who: { readonly me: boolean; readonly member: string | null }) => string;
}) {
  const t = useTranslations("Tasks");
  const [filter, setFilter] = useState<OccurrenceFilter>(initial.filter);
  const pages = useInfiniteQuery({
    queryKey: taskKeys.occurrences(userId, task.id, filter, loadedAt),
    initialPageParam: 0,
    ...(filter === initial.filter
      ? { initialData: { pages: [initial], pageParams: [0] }, staleTime: Number.POSITIVE_INFINITY }
      : {}),
    queryFn: ({ pageParam }) =>
      sendTaskRequest<OccurrencePage>(
        "GET",
        `${TASKS_ENDPOINT}/${task.id}/occurrences?filter=${filter}&offset=${String(pageParam)}`,
      ),
    getNextPageParam: (_last, all) => {
      const loaded = all.reduce((sum, page) => sum + page.occurrences.length, 0);
      return loaded < (all[0]?.total ?? 0) ? loaded : undefined;
    },
  });
  const rows = pages.data?.pages.flatMap((page) => page.occurrences) ?? [];
  const total = pages.data?.pages[0]?.total ?? 0;
  const base = tasksPath(task.homeId);

  return (
    <div className="mt-2 flex flex-col gap-3" data-testid="series-history">
      <h3 className="text-body font-semibold text-fg">{t("historyHeading")}</h3>
      <SelectField
        label={t("historyFilter")}
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value as OccurrenceFilter);
        }}
        options={occurrenceFilters.map((value) => ({ value, label: t(filterKey[value]) }))}
        className="max-w-60"
        data-testid="history-filter"
      />
      <p className="text-helper text-fg-muted" aria-live="polite">
        {pages.isPending ? t("historyLoading") : t("historyCount", { count: total })}
      </p>
      {pages.isError ? (
        <FormAlert tone="error" announce>
          {t("historyFailed")}
        </FormAlert>
      ) : null}
      {rows.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line rounded-card border border-line">
          {rows.map((row) => (
            <HistoryRow key={row.id} row={row} base={base} formats={formats} person={person} />
          ))}
        </ul>
      ) : null}
      {pages.hasNextPage ? (
        <div>
          <Button
            variant="secondary"
            loading={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
            data-testid="history-more"
          >
            {t("historyMore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function HistoryRow({
  row,
  base,
  formats,
  person,
}: {
  readonly row: OccurrenceRow;
  readonly base: string;
  readonly formats: DateTimeFormats;
  readonly person: (who: { readonly me: boolean; readonly member: string | null }) => string;
}) {
  const t = useTranslations("Tasks");
  const date = formatTaskDate(row.occurrenceDate, formats);
  const status = t(statusKey[row.status]);
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2 text-body">
      <span className="font-medium text-fg">
        {row.current ? (
          <>
            {date} <span className="text-fg-muted">{t("historyThis")}</span>
          </>
        ) : (
          <Link href={`${base}/${row.id}`} className="text-accent-fg underline">
            {date}
          </Link>
        )}
      </span>
      <span className={row.status === "missed" ? "font-semibold text-danger" : "text-fg"}>
        {row.completedAt
          ? t("historyCompletedBy", {
              status,
              person: row.completedBy ? person(row.completedBy) : t("personFormer"),
              date: formatDateTime(row.completedAt, formats),
            })
          : status}
      </span>
    </li>
  );
}
