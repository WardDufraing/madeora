"use client";

import { useTranslations } from "next-intl";
import { useId, useMemo, useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { RadioOption } from "@/components/settings/radio-option";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import {
  draftRule,
  RepeatFields,
  repeatSchema,
  type RepeatDraft,
} from "@/components/tasks/repeat-fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import {
  CHORE_OCCURRENCES_ENDPOINT,
  sendChoreRequest,
  type ChoreOccurrenceDetail,
  type OccurrenceChangeResponse,
  type OccurrenceImpact,
  type SeriesChangeResponse,
  type SeriesImpact,
} from "@/chores/api";
import { choresPath } from "@/chores/format";
import { CHORE_LIMITS, type ChoreScope } from "@/chores/schema";
import type { DateFormat } from "@/preferences/schema";
import { memberNames, type MemberOption } from "@/tasks/format";
import { dateOnlySchema } from "@/tasks/schema";
import { useRouter } from "next/navigation";

import { AssignmentEditor, type AssignmentDraft } from "./assignment-editor";
import {
  assignmentDraftSchema,
  minutesDraftSchema,
  stepDraftsSchema,
  useChoreFieldMessage,
} from "./chore-form";
import { NextDates } from "./chore-repeats";
import { RotationPreview } from "./rotation-preview";
import { StepsEditor, type StepDraft } from "./steps-editor";
import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

type Scope = "occurrence" | ChoreScope;

export interface ChoreEditProps {
  readonly occurrence: ChoreOccurrenceDetail;
  readonly members: readonly MemberOption[];
  readonly dateFormat: DateFormat;
}

type Preview =
  | { readonly kind: "occurrence"; readonly impact: OccurrenceImpact; readonly body: object }
  | { readonly kind: "series"; readonly impact: SeriesImpact; readonly body: object };

const sameSteps = (
  a: readonly { readonly label: string; readonly mandatory: boolean }[],
  b: readonly { readonly label: string; readonly mandatory: boolean }[],
) =>
  a.length === b.length &&
  a.every((step, index) => {
    const other = b[index];
    return other !== undefined && step.label === other.label && step.mandatory === other.mandatory;
  });

/**
 * Changing an open occurrence (S20, chore managers) with the scopes of recurring work: only this
 * occurrence (due date, assignees, estimate and its own checklist), this and following, or the
 * entire series (who it is for, the checklist, the estimate and the schedule). Only what was
 * changed is sent; the server previews the same change first (what is updated, kept, removed),
 * and completed or skipped occurrences never change.
 */
export function ChoreEdit({ occurrence, members, dateFormat }: ChoreEditProps) {
  const t = useTranslations("Chores");
  const router = useRouter();
  const names = useMemo(() => memberNames(members), [members]);
  const texts = useChoreTexts(names);
  const message = useChoreFieldMessage();
  const radio = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const { announce, region } = useAnnouncer();
  const schedule = occurrence.schedule;
  const recurring = schedule !== null && !schedule.ended;
  const initialSteps = (): StepDraft[] =>
    occurrence.steps.map((step) => ({
      key: step.id,
      id: step.id,
      label: step.label,
      mandatory: step.mandatory,
    }));
  const templateSteps = (): StepDraft[] =>
    (schedule?.steps ?? []).map((step) => ({
      key: crypto.randomUUID(),
      id: null,
      label: step.label,
      mandatory: step.mandatory,
    }));
  const initialRepeat = (): RepeatDraft => ({
    frequency: schedule?.frequency ?? "weekly",
    interval: String(schedule?.interval ?? 1),
    weekdays: [...(schedule?.weekdays ?? [])],
    ends: schedule?.count != null ? "after" : schedule?.endsOn != null ? "on" : "never",
    endsOn: schedule?.endsOn ?? "",
    count: schedule?.count != null ? String(schedule.count) : "",
  });
  const initialAssignment = (): AssignmentDraft => ({
    mode: schedule?.assignment ?? "none",
    // A departed member's empty place cannot be chosen again; it is left out of the order.
    members: (schedule?.members ?? []).filter((id): id is string => id !== null),
  });

  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>("occurrence");
  const [dueDate, setDueDate] = useState(occurrence.dueDate);
  const [assigneeIds, setAssigneeIds] = useState<readonly string[]>(
    occurrence.assigneeIds.filter((id): id is string => id !== null),
  );
  const [minutes, setMinutes] = useState(String(occurrence.minutes ?? ""));
  const [steps, setSteps] = useState<StepDraft[]>(initialSteps);
  const [seriesSteps, setSeriesSteps] = useState<StepDraft[]>(templateSteps);
  const [seriesMinutes, setSeriesMinutes] = useState(String(schedule?.minutes ?? ""));
  const [assignment, setAssignment] = useState<AssignmentDraft>(initialAssignment);
  const [repeat, setRepeat] = useState<RepeatDraft>(initialRepeat);
  const [startsOn, setStartsOn] = useState(
    scope === "following"
      ? occurrence.scheduledDate
      : (schedule?.startsOn ?? occurrence.scheduledDate),
  );
  const [confirmChecklist, setConfirmChecklist] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string | undefined>>>({});

  const reset = () => {
    setScope("occurrence");
    setDueDate(occurrence.dueDate);
    setAssigneeIds(occurrence.assigneeIds.filter((id): id is string => id !== null));
    setMinutes(String(occurrence.minutes ?? ""));
    setSteps(initialSteps());
    setSeriesSteps(templateSteps());
    setSeriesMinutes(String(schedule?.minutes ?? ""));
    setAssignment(initialAssignment());
    setRepeat(initialRepeat());
    setStartsOn(schedule?.startsOn ?? occurrence.scheduledDate);
    setConfirmChecklist(false);
    setPreview(null);
    setProblem(null);
    setErrors({});
  };
  const changed = () => {
    setPreview(null);
    setProblem(null);
  };

  const url = `${CHORE_OCCURRENCES_ENDPOINT}/${occurrence.id}`;
  const occurrenceMutation = useChoreMutation(
    `chore-occurrence:${occurrence.id}`,
    (input: { body: object; dryRun: boolean }) =>
      sendChoreRequest<OccurrenceChangeResponse>("PATCH", url, {
        ...input.body,
        dryRun: input.dryRun,
      }),
    (result, input) => {
      if (input.dryRun) {
        setPreview({ kind: "occurrence", impact: result.impact, body: input.body });
        return;
      }
      announce(t("announceSaved"));
      setOpen(false);
      requestAnimationFrame(() => opener.current?.focus());
    },
    { refresh: (_, input) => !input.dryRun },
  );
  const seriesMutation = useChoreMutation(
    `chore-occurrence:${occurrence.id}`,
    (input: { body: object; dryRun: boolean }) =>
      sendChoreRequest<SeriesChangeResponse>("POST", `${url}/series`, {
        ...input.body,
        dryRun: input.dryRun,
      }),
    (result, input) => {
      if (input.dryRun) {
        setPreview({ kind: "series", impact: result.impact, body: input.body });
        return;
      }
      announce(t("announceSaved"));
      setOpen(false);
      // The change removed this occurrence from the schedule: open the chore's next one.
      if (result.impact.selectedRemoved) {
        router.push(
          result.occurrenceId
            ? `${choresPath(occurrence.homeId)}/${result.occurrenceId}`
            : choresPath(occurrence.homeId),
        );
      } else {
        requestAnimationFrame(() => opener.current?.focus());
      }
    },
    { refresh: (_, input) => !input.dryRun },
  );
  const error = occurrenceMutation.error ?? seriesMutation.error;
  const busy = occurrenceMutation.busy || seriesMutation.busy;

  /** The request body of what changed, or null with the field errors shown. */
  function bodyOf(): object | null {
    const found: Record<string, string | undefined> = {};
    if (scope === "occurrence") {
      const body: Record<string, unknown> = { expectedRevision: occurrence.revision };
      if (!dateOnlySchema.safeParse(dueDate).success)
        found.dueDate = message({ message: "required" });
      const parsedMinutes = minutesDraftSchema.safeParse(minutes);
      if (!parsedMinutes.success) found.minutes = message(parsedMinutes.error.issues[0]);
      const parsedSteps = stepDraftsSchema.safeParse(steps);
      if (!parsedSteps.success) found.steps = message(parsedSteps.error.issues[0]);
      setErrors(found);
      if (Object.values(found).some(Boolean) || !parsedMinutes.success || !parsedSteps.success) {
        return null;
      }
      if (dueDate !== occurrence.dueDate) body.dueDate = dueDate;
      const current = occurrence.assigneeIds.filter((id): id is string => id !== null);
      if (
        assigneeIds.length !== current.length ||
        assigneeIds.some((id) => !current.includes(id))
      ) {
        body.assigneeIds = [...assigneeIds];
      }
      if (parsedMinutes.data !== occurrence.minutes) body.minutes = parsedMinutes.data;
      const nextSteps = parsedSteps.data.map(({ id, label, mandatory }) => ({
        id,
        label,
        mandatory,
      }));
      if (
        !sameSteps(nextSteps, occurrence.steps) ||
        nextSteps.some((step, index) => step.id !== occurrence.steps[index]?.id)
      ) {
        body.steps = nextSteps;
      }
      if (confirmChecklist) body.confirmChecklist = true;
      return Object.keys(body).length > (confirmChecklist ? 2 : 1) ? body : nothingChanged();
    }
    const body: Record<string, unknown> = {
      scope,
      expectedRevision: occurrence.revision,
      expectedScheduleRevision: schedule?.revision ?? 1,
    };
    const parsedAssignment = assignmentDraftSchema.safeParse(assignment);
    if (!parsedAssignment.success) found.assignment = message(parsedAssignment.error.issues[0]);
    const parsedMinutes = minutesDraftSchema.safeParse(seriesMinutes);
    if (!parsedMinutes.success) found.minutes = message(parsedMinutes.error.issues[0]);
    const parsedSteps = stepDraftsSchema.safeParse(seriesSteps);
    if (!parsedSteps.success) found.steps = message(parsedSteps.error.issues[0]);
    const parsedRepeat = repeatSchema.safeParse(repeat);
    const rule = draftRule(repeat, startsOn || null);
    if (!parsedRepeat.success || !rule) found.repeat = t("repeatInvalid");
    setErrors(found);
    if (
      Object.values(found).some(Boolean) ||
      !parsedAssignment.success ||
      !parsedMinutes.success ||
      !parsedSteps.success ||
      !rule
    ) {
      return null;
    }
    // An order with a departed member's empty place counts as changed: saving it repairs it.
    const initial = initialAssignment();
    if (
      parsedAssignment.data.mode !== initial.mode ||
      parsedAssignment.data.members.join() !== initial.members.join() ||
      (schedule?.members ?? []).includes(null)
    ) {
      body.assignment = parsedAssignment.data;
    }
    if (parsedMinutes.data !== (schedule?.minutes ?? null)) body.minutes = parsedMinutes.data;
    const nextSteps = parsedSteps.data.map(({ label, mandatory }) => ({ label, mandatory }));
    if (!sameSteps(nextSteps, schedule?.steps ?? [])) body.steps = nextSteps;
    // "This and following" starts the schedule at this occurrence by default: not a change itself.
    const before = draftRule(
      initialRepeat(),
      scope === "following" ? occurrence.scheduledDate : (schedule?.startsOn ?? null),
    );
    if (JSON.stringify(rule) !== JSON.stringify(before)) body.schedule = rule;
    return Object.keys(body).length > 3 ? body : nothingChanged();
  }
  function nothingChanged(): null {
    setProblem(t("nothingChanged"));
    return null;
  }
  function run(dryRun: boolean) {
    const body = dryRun ? bodyOf() : preview?.body;
    if (!body) return;
    if (scope === "occurrence") occurrenceMutation.mutate({ body, dryRun });
    else seriesMutation.mutate({ body, dryRun });
  }

  const nameOf = (id: string) => texts.member(id);
  const rotationRule = scope !== "occurrence" ? draftRule(repeat, startsOn || null) : null;
  const firstAffected =
    scope === "following"
      ? occurrence.scheduledDate
      : occurrence.today > occurrence.scheduledDate
        ? occurrence.today
        : occurrence.scheduledDate;
  const needsConfirm =
    error?.failure === "needsConfirmation" ||
    (preview?.kind === "occurrence" &&
      (preview.impact.removedChecked > 0 || preview.impact.newlyMandatory > 0));

  if (!open) {
    return (
      <HydrationGate>
        {region}
        <div>
          <Button
            ref={opener}
            variant="secondary"
            onClick={() => {
              reset();
              occurrenceMutation.reset();
              seriesMutation.reset();
              setOpen(true);
            }}
            data-testid="chore-edit-open"
          >
            {recurring ? t("editOccurrenceOrSeries") : t("editOccurrence")}
          </Button>
        </div>
      </HydrationGate>
    );
  }

  return (
    <section aria-labelledby="chore-edit-heading" className="flex flex-col gap-4">
      <HydrationGate>
        {region}
        <h2 id="chore-edit-heading" className="text-section-title font-semibold text-fg">
          {t("editHeading")}
        </h2>
        <div
          className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
          data-testid="chore-edit-form"
        >
          {recurring ? (
            <fieldset className="flex flex-col gap-1">
              <legend className="text-body font-medium text-fg">{t("scopeLegend")}</legend>
              <RadioOption
                name={radio}
                value="occurrence"
                label={t("scopeOccurrence")}
                checked={scope === "occurrence"}
                onChange={() => {
                  setScope("occurrence");
                  changed();
                }}
              />
              {schedule.inHead ? (
                <RadioOption
                  name={radio}
                  value="following"
                  label={t("scopeFollowing")}
                  description={t("scopeFollowingHelp")}
                  checked={scope === "following"}
                  onChange={() => {
                    setScope("following");
                    setStartsOn(occurrence.scheduledDate);
                    changed();
                  }}
                />
              ) : null}
              <RadioOption
                name={radio}
                value="series"
                label={t("scopeSeries")}
                description={t("scopeSeriesHelp")}
                checked={scope === "series"}
                onChange={() => {
                  setScope("series");
                  setStartsOn(schedule.startsOn);
                  changed();
                }}
              />
            </fieldset>
          ) : null}

          {scope === "occurrence" ? (
            <>
              <TextField
                type="date"
                label={t("fieldDueDate")}
                value={dueDate}
                onChange={(event) => {
                  setDueDate(event.target.value);
                  changed();
                }}
                error={errors.dueDate}
                className="max-w-60"
                data-testid="chore-edit-due"
              />
              <fieldset className="flex flex-col gap-1">
                <legend className="text-body font-medium text-fg">{t("fieldAssignees")}</legend>
                {members.map((member) => (
                  <Checkbox
                    key={member.id}
                    label={nameOf(member.id)}
                    checked={assigneeIds.includes(member.id)}
                    disabled={
                      !assigneeIds.includes(member.id) && assigneeIds.length >= CHORE_LIMITS.members
                    }
                    onChange={(event) => {
                      setAssigneeIds(
                        event.target.checked
                          ? [...assigneeIds, member.id]
                          : assigneeIds.filter((id) => id !== member.id),
                      );
                      changed();
                    }}
                  />
                ))}
              </fieldset>
              <TextField
                type="number"
                inputMode="numeric"
                min={1}
                max={CHORE_LIMITS.minutes}
                label={t("fieldMinutes")}
                description={t("fieldMinutesHelp")}
                value={minutes}
                onChange={(event) => {
                  setMinutes(event.target.value);
                  changed();
                }}
                error={errors.minutes}
                className="max-w-48"
              />
              <StepsEditor
                value={steps}
                onChange={(value) => {
                  setSteps(value);
                  setConfirmChecklist(false);
                  changed();
                }}
                error={errors.steps}
              />
            </>
          ) : (
            <>
              <AssignmentEditor
                value={assignment}
                onChange={(value) => {
                  setAssignment(value);
                  changed();
                }}
                members={members}
                allowRotation
                error={errors.assignment}
              />
              {assignment.mode === "rotating" ? (
                <RotationPreview
                  rule={rotationRule}
                  rotationFrom={firstAffected}
                  order={assignment.members}
                  nameOf={nameOf}
                  dateFormat={dateFormat}
                />
              ) : null}
              <TextField
                type="number"
                inputMode="numeric"
                min={1}
                max={CHORE_LIMITS.minutes}
                label={t("fieldMinutes")}
                description={t("fieldMinutesHelp")}
                value={seriesMinutes}
                onChange={(event) => {
                  setSeriesMinutes(event.target.value);
                  changed();
                }}
                error={errors.minutes}
                className="max-w-48"
              />
              <StepsEditor
                value={seriesSteps}
                onChange={(value) => {
                  setSeriesSteps(value);
                  changed();
                }}
                error={errors.steps}
              />
              <TextField
                type="date"
                label={t("fieldFirstDate")}
                description={scope === "following" ? t("followingStartHelp") : t("seriesStartHelp")}
                value={startsOn}
                onChange={(event) => {
                  setStartsOn(event.target.value);
                  changed();
                }}
                className="max-w-60"
              />
              <RepeatFields
                value={repeat}
                onChange={(value) => {
                  setRepeat(value);
                  changed();
                }}
                startsOn={startsOn || null}
                errors={{}}
                dateFormat={dateFormat}
                allowNone={false}
              />
              {errors.repeat ? (
                <p className="text-helper text-danger" role="alert">
                  {errors.repeat}
                </p>
              ) : null}
            </>
          )}

          {preview ? (
            <div
              className="flex flex-col gap-2 rounded-card border border-line bg-surface-sunken p-3 text-body text-fg"
              aria-live="polite"
              data-testid="chore-edit-preview"
            >
              <p className="font-medium">{t("previewHeading")}</p>
              {preview.kind === "occurrence" ? (
                <p>
                  {t("occurrenceImpact", {
                    removed: preview.impact.removed,
                    removedChecked: preview.impact.removedChecked,
                    added: preview.impact.added,
                    newlyMandatory: preview.impact.newlyMandatory,
                  })}
                </p>
              ) : (
                <>
                  <p>
                    {t("seriesImpact", {
                      updated: preview.impact.updated,
                      kept: preview.impact.kept,
                      removed: preview.impact.removed,
                      completed: preview.impact.completed,
                    })}
                  </p>
                  {preview.impact.overdueKept > 0 ? (
                    <p>{t("overdueKept", { count: preview.impact.overdueKept })}</p>
                  ) : null}
                  {preview.impact.stepsKept > 0 ? (
                    <p>{t("stepsKept", { count: preview.impact.stepsKept })}</p>
                  ) : null}
                  {preview.impact.selectedRemoved ? <p>{t("selectedRemoved")}</p> : null}
                  <h3 className="font-semibold">{t("nextDatesHeading")}</h3>
                  <NextDates
                    next={preview.impact.next}
                    nameOf={(id) => texts.member(id)}
                    formats={{ dateFormat }}
                  />
                </>
              )}
            </div>
          ) : null}
          {needsConfirm && scope === "occurrence" ? (
            <Checkbox
              label={t("confirmChecklist")}
              description={t("confirmChecklistHelp")}
              checked={confirmChecklist}
              onChange={(event) => {
                setConfirmChecklist(event.target.checked);
                setPreview(null);
              }}
              data-testid="chore-confirm-checklist"
            />
          ) : null}
          {problem ? (
            <FormAlert tone="error" announce>
              {problem}
            </FormAlert>
          ) : null}
          {error && error.failure !== "needsConfirmation" ? (
            <FormAlert tone="error" announce>
              {texts.failure(error.failure, error.detail)}
            </FormAlert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {preview && !(needsConfirm && scope === "occurrence" && !confirmChecklist) ? (
              <Button
                loading={busy}
                onClick={() => {
                  run(false);
                }}
                data-testid="chore-edit-save"
              >
                {t("save")}
              </Button>
            ) : (
              <Button
                loading={busy}
                onClick={() => {
                  run(true);
                }}
                data-testid="chore-edit-check"
              >
                {t("preview")}
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => {
                setOpen(false);
                requestAnimationFrame(() => opener.current?.focus());
              }}
            >
              {t("cancel")}
            </Button>
          </div>
        </div>
      </HydrationGate>
    </section>
  );
}
