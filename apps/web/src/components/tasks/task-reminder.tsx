"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useDeferredValue, useId, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { FormAlert } from "@/components/auth/form-alert";
import { RadioOption } from "@/components/settings/radio-option";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { formatDateTime, type DateTimeFormats } from "@/invitations/format";
import {
  sendTaskRequest,
  TASKS_ENDPOINT,
  type TaskRequestError,
  type DstCase,
  type ReminderImpact,
  type ReminderRemoveResponse,
  type ReminderReviewResponse,
  type ReminderSaveResponse,
  type TaskReminder,
  type TaskReminderView,
} from "@/tasks/api";
import { memberNames, type MemberOption } from "@/tasks/format";
import {
  clockTimeSchema,
  dateOnlySchema,
  TASK_LIMITS,
  type ReminderScope,
  type SetReminderInput,
} from "@/tasks/schema";

import { HydrationGate } from "./hydration-gate";
import { useTaskMutation } from "./use-task-mutation";
import { useTaskTexts } from "./use-task-texts";

/** A reminder change without its scope, revisions and dry-run flag, which the sender adds. */
type ReminderBody =
  | { readonly mode: "absolute"; readonly localAt: string }
  | { readonly mode: "relative"; readonly daysBefore: number; readonly time: string };

function reminderUrl(taskId: string): string {
  return `${TASKS_ENDPOINT}/${taskId}/reminder`;
}

function revisions(view: TaskReminderView) {
  return {
    expectedRevision: view.reminder?.revision ?? 0,
    expectedSeriesRevision: view.seriesReminder?.revision ?? 0,
  };
}

function sendSet(
  view: TaskReminderView,
  scope: ReminderScope,
  body: ReminderBody,
  dryRun: boolean,
): Promise<ReminderSaveResponse> {
  const { expectedRevision, expectedSeriesRevision } = revisions(view);
  const input: SetReminderInput = {
    ...body,
    scope,
    expectedRevision,
    expectedSeriesRevision: scope === "this" ? null : expectedSeriesRevision,
    dryRun,
  };
  return sendTaskRequest<ReminderSaveResponse>("PUT", reminderUrl(view.taskId), input);
}

function sendRemove(
  view: TaskReminderView,
  scope: ReminderScope,
  dryRun: boolean,
): Promise<ReminderRemoveResponse> {
  const { expectedRevision, expectedSeriesRevision } = revisions(view);
  return sendTaskRequest<ReminderRemoveResponse>("DELETE", reminderUrl(view.taskId), {
    scope,
    expectedRevision,
    expectedSeriesRevision: scope === "this" ? null : expectedSeriesRevision,
    dryRun,
  });
}

const formSchema = z
  .object({
    mode: z.enum(["absolute", "relative"]),
    date: z.string(),
    time: z.string(),
    daysBefore: z.string(),
    relativeTime: z.string(),
  })
  .superRefine((values, context) => {
    if (values.mode === "absolute") {
      if (!dateOnlySchema.safeParse(values.date).success) {
        context.addIssue({ code: "custom", path: ["date"], message: "date" });
      }
      if (!clockTimeSchema.safeParse(values.time).success) {
        context.addIssue({ code: "custom", path: ["time"], message: "time" });
      }
      return;
    }
    const days = Number(values.daysBefore);
    if (!/^\d{1,2}$/.test(values.daysBefore) || days > TASK_LIMITS.reminderDays) {
      context.addIssue({ code: "custom", path: ["daysBefore"], message: "days" });
    }
    if (!clockTimeSchema.safeParse(values.relativeTime).success) {
      context.addIssue({ code: "custom", path: ["relativeTime"], message: "time" });
    }
  });
type FormValues = z.infer<typeof formSchema>;

function bodyOf(values: FormValues): ReminderBody | null {
  if (!formSchema.safeParse(values).success) return null;
  return values.mode === "absolute"
    ? { mode: "absolute", localAt: `${values.date}T${values.time}` }
    : { mode: "relative", daysBefore: Number(values.daysBefore), time: values.relativeTime };
}

/** A reminder time in its zone, with the zone named: "28/03/2027 09:00 (Europe/Brussels)". */
function useReminderTime(formats: DateTimeFormats) {
  return (instant: string, timeZone: string) =>
    `${formatDateTime(instant, { ...formats, timeZone })} (${timeZone})`;
}

export interface TaskReminderSectionProps {
  readonly view: TaskReminderView;
  readonly members: readonly MemberOption[];
  readonly formats: DateTimeFormats;
  /** Today in the reminder's zone, the default date of a new reminder at a date and time. */
  readonly today: string;
}

/**
 * A task's reminder (S19b; spec "Confirmed individual task reminders"): when it comes, who gets it
 * and how the viewer would receive it, with set, change and remove for people who may edit the
 * task. Times are resolved by the server in the Home's zone (or the person's own for the Personal
 * space), so the preview and the delivery cannot differ; a time on a DST change says how it was
 * resolved. On an occurrence, a reminder before the due date can apply to this occurrence, this and
 * following ones or the entire series, with the impact shown first. A reminder put on hold by a
 * changed due date waits for the person's choice.
 */
export function TaskReminderSection({ view, members, formats, today }: TaskReminderSectionProps) {
  const t = useTranslations("TaskReminders");
  const texts = useTaskTexts(memberNames(members));
  const reminderTime = useReminderTime(formats);
  const [editing, setEditing] = useState(false);
  const [scopeRequest, setScopeRequest] = useState<
    { readonly kind: "set"; readonly body: ReminderBody } | { readonly kind: "remove" } | null
  >(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const { announce, region } = useAnnouncer();
  const reminder = view.reminder;
  const series = view.seriesReminder;
  const zone = reminder?.timeZone ?? view.timeZone;

  function finish(message: string) {
    setScopeRequest(null);
    setEditing(false);
    announce(message);
    requestAnimationFrame(() => changeButton.current?.focus());
  }
  const save = useTaskMutation(
    `task:${view.taskId}`,
    ({ scope, body }: { readonly scope: ReminderScope; readonly body: ReminderBody }) =>
      sendSet(view, scope, body, false),
    () => {
      finish(t("announceSaved"));
    },
  );
  const remove = useTaskMutation(
    `task:${view.taskId}`,
    (scope: ReminderScope) => sendRemove(view, scope, false),
    () => {
      finish(t("announceRemoved"));
    },
  );
  const review = useTaskMutation(
    `task:${view.taskId}`,
    (choice: "follow" | "remove") =>
      sendTaskRequest<ReminderReviewResponse>("POST", `${reminderUrl(view.taskId)}/review`, {
        choice,
        expectedRevision: reminder?.revision ?? 1,
      }),
    () => {
      finish(t("announceSaved"));
    },
  );
  const busy = save.busy || remove.busy || review.busy;
  const canChange = view.canEdit && !view.completed;
  // The series' reminder can be changed from an occurrence by those who may change the series.
  const seriesChoice = view.recurring && view.canEditSeries;
  const active = reminder !== null && reminder.status !== "off";

  function submit(body: ReminderBody) {
    if (seriesChoice && body.mode === "relative") {
      setScopeRequest({ kind: "set", body });
      return;
    }
    save.mutate({ scope: "this", body });
  }

  function startRemove() {
    if (seriesChoice && series?.active) {
      setScopeRequest({ kind: "remove" });
      return;
    }
    remove.mutate("this");
  }

  const names =
    view.recipients === null ? [t("you")] : view.recipients.map((id) => texts.member(id));
  const channel = view.channels.inApp
    ? view.channels.email
      ? t("channelBoth")
      : t("channelInApp")
    : view.channels.email
      ? t("channelEmail")
      : null;
  const actionError = save.error ?? remove.error ?? review.error;

  return (
    <section aria-labelledby="task-reminder-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2 id="task-reminder-heading" className="text-section-title font-semibold text-fg">
          {t("heading")}
        </h2>
        <div className="flex flex-col gap-2 text-body text-fg" data-testid="task-reminder">
          {reminder ? (
            <ReminderSummary
              reminder={reminder}
              reminderTime={reminderTime}
              recurring={view.recurring}
            />
          ) : (
            <p className="text-fg-muted">{t("none")}</p>
          )}
          {view.recurring && series?.active && series.daysBefore !== null && series.time ? (
            <p className="text-fg-muted" data-testid="series-reminder">
              {t("seriesReminder", { days: series.daysBefore, time: series.time })}
            </p>
          ) : null}
          {reminder?.status === "needs_review" ? (
            <FormAlert tone="info">
              <p className="font-medium">{t("reviewTitle")}</p>
              <p>
                {reminder.reviewFireAt && reminder.timeZone && view.dueDate
                  ? t("reviewMove", {
                      date: reminderTime(reminder.reviewFireAt, reminder.timeZone),
                    })
                  : t("reviewNoDue")}
              </p>
              <DstNote dst={reminder.reviewDst} />
              {canChange ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {view.dueDate ? (
                    <Button
                      size="sm"
                      disabled={busy}
                      loading={review.isPending && review.variables === "follow"}
                      onClick={() => {
                        review.mutate("follow");
                      }}
                    >
                      {t("reviewFollow")}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    loading={review.isPending && review.variables === "remove"}
                    onClick={() => {
                      review.mutate("remove");
                    }}
                  >
                    {t("reviewRemove")}
                  </Button>
                </div>
              ) : null}
            </FormAlert>
          ) : null}
          {active || editing ? (
            <p data-testid="reminder-recipients">
              {view.recipients === null
                ? t("recipientsPersonal")
                : names.length === 0
                  ? t("recipientsNobody")
                  : view.recipientsAreAssignees
                    ? t("recipientsAssignees", { names: names.join(", ") })
                    : t("recipientsSetter", { names: names.join(", ") })}
            </p>
          ) : null}
          {active || editing ? (
            channel ? (
              <p className="text-fg-muted" data-testid="reminder-channel">
                {channel}
              </p>
            ) : (
              <FormAlert tone="info">
                <p data-testid="reminder-channel">
                  {t("channelOff")}{" "}
                  <Link
                    href="/settings/notifications"
                    className="font-medium text-accent-fg underline"
                  >
                    {t("channelSettings")}
                  </Link>
                </p>
              </FormAlert>
            )
          ) : null}
        </div>

        {canChange && !editing ? (
          <div className="flex flex-wrap gap-2">
            <Button
              ref={changeButton}
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => {
                save.reset();
                setEditing(true);
              }}
            >
              {active ? t("change") : t("set")}
            </Button>
            {active ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                loading={remove.isPending && scopeRequest === null}
                onClick={startRemove}
              >
                {t("remove")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {!canChange && view.completed ? (
          <p className="text-helper text-fg-muted">{t("completedNote")}</p>
        ) : null}

        {editing ? (
          <ReminderForm
            view={view}
            today={today}
            zone={zone}
            busy={busy}
            seriesChoice={seriesChoice}
            reminderTime={reminderTime}
            onSubmit={submit}
            onCancel={() => {
              setEditing(false);
              save.reset();
              requestAnimationFrame(() => changeButton.current?.focus());
            }}
            error={scopeRequest ? null : save.error}
          />
        ) : null}

        {actionError && !editing && !scopeRequest ? <Failure error={actionError} /> : null}

        {scopeRequest ? (
          <ReminderScopeDialog
            view={view}
            request={scopeRequest}
            busy={busy}
            error={scopeRequest.kind === "set" ? save.error : remove.error}
            onClose={() => {
              setScopeRequest(null);
              save.reset();
              remove.reset();
            }}
            onConfirm={(scope) => {
              if (scopeRequest.kind === "set") save.mutate({ scope, body: scopeRequest.body });
              else remove.mutate(scope);
            }}
          />
        ) : null}
      </HydrationGate>
    </section>
  );
}

function ReminderSummary({
  reminder,
  reminderTime,
  recurring,
}: {
  readonly reminder: TaskReminder;
  readonly reminderTime: (instant: string, timeZone: string) => string;
  readonly recurring: boolean;
}) {
  const t = useTranslations("TaskReminders");
  if (reminder.status === "off") {
    return <p className="text-fg-muted">{t("offForOccurrence")}</p>;
  }
  // No time while on hold (the due date changed): only the rule is shown.
  const when =
    reminder.fireAt && reminder.timeZone ? reminderTime(reminder.fireAt, reminder.timeZone) : null;
  const rule =
    reminder.mode === "relative" && reminder.daysBefore !== null && reminder.time
      ? t("ruleRelative", { days: reminder.daysBefore, time: reminder.time })
      : null;
  return (
    <>
      <p data-testid="reminder-summary">
        {when === null || reminder.status === "needs_review"
          ? t("onHold")
          : reminder.status === "sent"
            ? t("sent", { date: when })
            : reminder.status === "not_sent"
              ? t("notSent", { date: when })
              : t("scheduled", { date: when })}
      </p>
      {rule ? <p className="text-fg-muted">{rule}</p> : null}
      {recurring ? (
        <p className="text-helper text-fg-muted">
          {reminder.own ? t("ownForOccurrence") : t("fromSeries")}
        </p>
      ) : null}
      {reminder.status === "scheduled" ? (
        <>
          <DstNote dst={reminder.dst} />
          <p className="text-helper text-fg-muted">{t("latency")}</p>
        </>
      ) : null}
    </>
  );
}

function DstNote({ dst }: { readonly dst: DstCase }) {
  const t = useTranslations("TaskReminders");
  if (dst === "gap") return <p className="text-helper text-fg">{t("dstGap")}</p>;
  if (dst === "overlap") return <p className="text-helper text-fg">{t("dstOverlap")}</p>;
  return null;
}

function Failure({ error }: { readonly error: TaskRequestError }) {
  const t = useTranslations("Tasks");
  const texts = useTaskTexts(memberNames([]));
  return (
    <FormAlert tone="error" announce>
      <p>{texts.failure(error.failure, error.detail)}</p>
      {error.failure === "conflict" ? (
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          onClick={() => {
            window.location.reload();
          }}
        >
          {t("loadLatest")}
        </Button>
      ) : null}
    </FormAlert>
  );
}

interface ReminderFormProps {
  readonly view: TaskReminderView;
  readonly today: string;
  readonly zone: string | null;
  readonly busy: boolean;
  readonly seriesChoice: boolean;
  readonly reminderTime: (instant: string, timeZone: string) => string;
  readonly onSubmit: (body: ReminderBody) => void;
  readonly onCancel: () => void;
  readonly error: TaskRequestError | null;
}

/** Sets or changes the reminder; the server previews the resolved time as the person types. */
function ReminderForm({
  view,
  today,
  zone,
  busy,
  seriesChoice,
  reminderTime,
  onSubmit,
  onCancel,
  error,
}: ReminderFormProps) {
  const t = useTranslations("TaskReminders");
  const texts = useTaskTexts(memberNames([]));
  const modeName = useId();
  const current = view.reminder;
  const localAt = current?.mode === "absolute" ? current.localAt : null;
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      mode: current?.mode ?? (view.dueDate ? "relative" : "absolute"),
      date: localAt?.slice(0, 10) ?? today,
      time: localAt?.slice(11, 16) ?? "09:00",
      daysBefore: String(current?.daysBefore ?? 1),
      relativeTime: current?.mode === "relative" ? (current.time ?? "09:00") : "09:00",
    },
  });
  const values = useWatch({ control: form.control }) as FormValues;
  const body = useDeferredValue(bodyOf(values));
  const errors = form.formState.errors;
  const relative = values.mode === "relative";

  const preview = useQuery<ReminderSaveResponse, TaskRequestError>({
    // Outside the `tasks` keys: a change invalidates those, and a preview is never reused.
    queryKey: ["task-reminder-preview", view.taskId, body],
    queryFn: () => sendSet(view, "this", body as ReminderBody, true),
    enabled: body !== null && !(body.mode === "relative" && view.dueDate === null),
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });

  return (
    <form
      method="post"
      noValidate
      aria-label={t("formLabel")}
      className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
      onSubmit={(event) => {
        void form.handleSubmit((submitted) => {
          const parsed = bodyOf(submitted);
          if (parsed) onSubmit(parsed);
        })(event);
      }}
    >
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-body font-medium text-fg">{t("modeLegend")}</legend>
        <RadioOption
          name={modeName}
          value="relative"
          label={t("modeRelative")}
          description={view.dueDate ? t("modeRelativeHelp") : t("modeRelativeNeedsDue")}
          disabled={view.dueDate === null}
          checked={relative}
          onChange={() => {
            form.setValue("mode", "relative");
          }}
        />
        <RadioOption
          name={modeName}
          value="absolute"
          label={t("modeAbsolute")}
          description={seriesChoice ? t("modeAbsoluteOccurrenceHelp") : t("modeAbsoluteHelp")}
          checked={!relative}
          onChange={() => {
            form.setValue("mode", "absolute");
          }}
        />
      </fieldset>
      {relative ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={t("daysBefore")}
            description={t("daysBeforeHelp", { max: TASK_LIMITS.reminderDays })}
            inputMode="numeric"
            error={
              errors.daysBefore ? t("invalidDays", { max: TASK_LIMITS.reminderDays }) : undefined
            }
            {...form.register("daysBefore")}
          />
          <TextField
            label={t("timeOfDay")}
            type="time"
            error={errors.relativeTime ? t("invalidTime") : undefined}
            {...form.register("relativeTime")}
          />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={t("date")}
            type="date"
            error={errors.date ? t("invalidDate") : undefined}
            {...form.register("date")}
          />
          <TextField
            label={t("timeOfDay")}
            type="time"
            error={errors.time ? t("invalidTime") : undefined}
            {...form.register("time")}
          />
        </div>
      )}
      {zone ? <p className="text-helper text-fg-muted">{t("zoneNote", { zone })}</p> : null}
      <div
        className="rounded-card border border-line bg-surface-sunken p-3 text-body"
        aria-live="polite"
        data-testid="reminder-preview"
      >
        {body === null ? (
          <p className="text-fg-muted">{t("previewIncomplete")}</p>
        ) : preview.isPending ? (
          <p className="text-fg-muted">{t("previewLoading")}</p>
        ) : preview.isError ? (
          <p className="text-danger">{texts.failure(preview.error.failure)}</p>
        ) : preview.data.fireAt && zone ? (
          <>
            <p className="text-fg">
              {t("previewAt", { date: reminderTime(preview.data.fireAt, zone) })}
            </p>
            <DstNote dst={preview.data.dst} />
          </>
        ) : null}
      </div>
      {error ? <Failure error={error} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy}>
          {t("save")}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}

interface ReminderScopeDialogProps {
  readonly view: TaskReminderView;
  readonly request:
    { readonly kind: "set"; readonly body: ReminderBody } | { readonly kind: "remove" };
  readonly busy: boolean;
  readonly error: TaskRequestError | null;
  readonly onClose: () => void;
  readonly onConfirm: (scope: ReminderScope) => void;
}

/**
 * Asks which occurrences a reminder change applies to: only this one, this and following, or the
 * entire series. For the series scopes it shows the server's dry run: how many occurrences change,
 * which keep a reminder of their own, which are already past, and that completed ones never change.
 */
function ReminderScopeDialog({
  view,
  request,
  busy,
  error,
  onClose,
  onConfirm,
}: ReminderScopeDialogProps) {
  const t = useTranslations("TaskReminders");
  const tTasks = useTranslations("Tasks");
  const texts = useTaskTexts(memberNames([]));
  const name = useId();
  const options: ReminderScope[] = [
    "this",
    ...(view.completed ? [] : (["following"] as const)),
    "series",
  ];
  const [scope, setScope] = useState<ReminderScope>("this");
  const preview = useQuery<ReminderSaveResponse | ReminderRemoveResponse, TaskRequestError>({
    queryKey: ["task-reminder-scope-preview", view.taskId, request, scope],
    queryFn: () =>
      request.kind === "set"
        ? sendSet(view, scope, request.body, true)
        : sendRemove(view, scope, true),
    enabled: scope !== "this",
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const labels = {
    this: tTasks("scopeThis"),
    following: tTasks("scopeFollowing"),
    series: tTasks("scopeSeries"),
  } as const;
  const help = {
    this: t("scopeThisHelp"),
    following: t("scopeFollowingHelp"),
    series: t("scopeSeriesHelp"),
  } as const;

  return (
    <Dialog
      open
      onClose={onClose}
      title={request.kind === "set" ? t("scopeSetTitle") : t("scopeRemoveTitle")}
      closeLabel={tTasks("close")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {tTasks("cancel")}
          </Button>
          <Button
            variant={request.kind === "remove" ? "destructive" : "primary"}
            loading={busy}
            disabled={scope !== "this" && (preview.isPending || preview.isError)}
            onClick={() => {
              onConfirm(scope);
            }}
            data-testid="reminder-scope-confirm"
          >
            {request.kind === "set" ? t("save") : t("remove")}
          </Button>
        </>
      }
    >
      <fieldset className="flex flex-col gap-1" data-testid="reminder-scope">
        <legend className="mb-1 text-body font-medium text-fg">{tTasks("scopeLegend")}</legend>
        {options.map((option) => (
          <RadioOption
            key={option}
            name={name}
            value={option}
            label={labels[option]}
            description={help[option]}
            checked={scope === option}
            onChange={() => {
              setScope(option);
            }}
          />
        ))}
      </fieldset>
      {scope !== "this" ? (
        <div
          className="rounded-card border border-line bg-surface-sunken p-3 text-body"
          aria-live="polite"
          aria-busy={preview.isPending}
          data-testid="reminder-impact"
        >
          {preview.isPending ? (
            <p className="text-fg-muted">{tTasks("impactLoading")}</p>
          ) : preview.isError ? (
            <p className="text-danger">{texts.failure(preview.error.failure)}</p>
          ) : preview.data.impact ? (
            <Impact impact={preview.data.impact} removing={request.kind === "remove"} />
          ) : null}
        </div>
      ) : null}
      {error ? <Failure error={error} /> : null}
    </Dialog>
  );
}

function Impact({
  impact,
  removing,
}: {
  readonly impact: ReminderImpact;
  readonly removing: boolean;
}) {
  const t = useTranslations("TaskReminders");
  return (
    <ul className="flex list-disc flex-col gap-1 ps-5 text-fg">
      <li>
        {removing
          ? t("impactRemoved", { count: impact.updated })
          : t("impactUpdated", { count: impact.updated })}
      </li>
      {impact.kept > 0 ? <li>{t("impactKept", { count: impact.kept })}</li> : null}
      {impact.past > 0 ? <li>{t("impactPast", { count: impact.past })}</li> : null}
      <li>{t("impactCompleted", { count: impact.completed })}</li>
      {removing ? null : <li>{t("impactNew")}</li>}
    </ul>
  );
}
