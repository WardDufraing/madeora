"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { instantFromZoned, zonedParts } from "@/chores/format";
import { careEndpoint, careOccurrenceEndpoint, sendPetRequest } from "@/pets/api";
import { PET_CARE_LIMITS, type PetCareState } from "@/pets/care-schema";
import type { CareActivityDetail, CareOccurrence } from "@/pets/care-shapes";
import { petPath } from "@/pets/format";

import { CareActivityForm } from "./care-activity-form";
import {
  CareStatus,
  CompleteButton,
  useCareNames,
  useOccurrenceWhen,
  useScheduleSummary,
  type CareMember,
} from "./care-parts";
import { ConfirmDialog, PetFailureAlert, PetValue } from "./pet-parts";
import { usePetMutation } from "./use-pet-mutation";
import { usePetTexts } from "./use-pet-texts";

type OccurrenceDialog =
  | { readonly kind: "change"; readonly occurrence: CareOccurrence }
  | { readonly kind: "correct"; readonly occurrence: CareOccurrence };

/**
 * One care activity (S31 care part): what it is, its schedule and reminder, its open occurrences
 * (complete, skip, change only this one or this and following) and its recent ones (who recorded
 * them and when the care was given; reopen and correct). Every member sees it and completes care;
 * the texts of an activity with medical details only with medical view.
 */
export function CareActivityView({
  activity,
  petName,
  members,
  canMarkMedical,
}: {
  readonly activity: CareActivityDetail;
  readonly petName: string;
  readonly members: readonly CareMember[];
  readonly canMarkMedical: boolean;
}) {
  const t = useTranslations("Pets");
  const texts = usePetTexts();
  const router = useRouter();
  const names = useCareNames(members);
  const summary = useScheduleSummary();
  const when = useOccurrenceWhen(activity.today);
  const [editing, setEditing] = useState<{ readonly from?: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [dialog, setDialog] = useState<OccurrenceDialog | null>(null);
  const title = texts.careTitle(activity);

  const setState = usePetMutation(`pet-care:${activity.id}`, (state: PetCareState) =>
    sendPetRequest("POST", careEndpoint(activity.id, "state"), {
      revision: activity.revision,
      state,
    }),
  );
  const remove = usePetMutation(
    `pet-care:${activity.id}`,
    () => sendPetRequest("DELETE", careEndpoint(activity.id), { revision: activity.revision }),
    () => {
      router.push(petPath(activity.homeId, activity.petId));
    },
  );
  const act = usePetMutation(
    `pet-care:${activity.id}:occurrence`,
    (input: { readonly id: string; readonly body: object }) =>
      sendPetRequest("POST", careOccurrenceEndpoint(input.id), input.body),
  );
  const completedAt = (instant: string) => {
    const parts = zonedParts(instant, activity.timeZone);
    return t("dayAtTime", { day: texts.shortDate(parts.date), time: parts.time });
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-page-title font-semibold text-fg" data-testid="care-heading">
          {title}
        </h1>
        <p className="text-helper text-fg-muted">
          {t("careFor", { pet: petName })} · {texts.careCategory(activity.category)}
          {activity.state === "paused" ? ` · ${t("carePaused")}` : ""}
          {activity.state === "ended" ? ` · ${t("careEnded")}` : ""}
        </p>
        {activity.concealed ? (
          <p className="text-helper text-fg-muted" data-testid="care-concealed">
            {t("careConcealed")}
          </p>
        ) : null}
      </div>

      <PetFailureAlert error={setState.error ?? act.error} />

      <Card
        title={t("careDetails")}
        headingLevel={2}
        action={
          <div className="flex flex-wrap gap-2">
            {activity.canEdit && activity.state !== "ended" ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setEditing({});
                }}
                data-testid="care-edit"
              >
                {t("careEdit")}
              </Button>
            ) : null}
            {activity.canManage && activity.state !== "ended" ? (
              <Button
                variant="secondary"
                size="sm"
                loading={setState.busy}
                onClick={() => {
                  setState.mutate(activity.state === "paused" ? "active" : "paused");
                }}
                data-testid="care-pause"
              >
                {activity.state === "paused" ? t("careResume") : t("carePause")}
              </Button>
            ) : null}
            {activity.canManage && activity.state !== "ended" ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setEnding(true);
                }}
              >
                {t("careEnd")}
              </Button>
            ) : null}
            {activity.canEdit ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setDeleting(true);
                }}
                data-testid="care-delete"
              >
                {t("delete")}
              </Button>
            ) : null}
          </div>
        }
      >
        <dl className="flex flex-col gap-3">
          {activity.schedule ? (
            <PetValue label={t("careSchedule")} testId="care-schedule">
              {summary(activity.schedule)}
            </PetValue>
          ) : null}
          {activity.schedule ? (
            <PetValue label={t("careFieldMembers")} testId="care-responsible">
              {names.list(activity.schedule.members)}
            </PetValue>
          ) : null}
          <PetValue label={t("careFieldReminder")}>
            {activity.reminder === null
              ? t("careReminderOff")
              : t("careReminderBefore", { minutes: activity.reminder })}
          </PetValue>
          {activity.concealed ? null : (
            <PetValue label={t("careFieldInstructions")} testId="care-instructions">
              {activity.instructions ?? <span className="text-fg-muted">{t("notEntered")}</span>}
            </PetValue>
          )}
          {activity.medical && !activity.concealed ? (
            <p className="text-helper text-fg-muted">{t("careMedicalNote")}</p>
          ) : null}
        </dl>
      </Card>

      <Card title={t("careOpen")} headingLevel={2}>
        {activity.open.length === 0 ? (
          <p className="text-body text-fg-muted">{t("careOpenNone")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line" data-testid="care-open">
            {activity.open.map((occurrence) => (
              <li
                key={occurrence.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
                data-testid="care-occurrence"
              >
                <div className="flex flex-col gap-1">
                  <p className="flex flex-wrap items-center gap-2 text-body text-fg">
                    <span>{when(occurrence)}</span>
                    <CareStatus status={occurrence.status} />
                  </p>
                  <p className="text-helper text-fg-muted">{names.list(occurrence.members)}</p>
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  {occurrence.status !== "paused" ? (
                    <CompleteButton
                      occurrence={occurrence}
                      label={t("careCompleteWhen", { title, when: when(occurrence) })}
                    />
                  ) : null}
                  {activity.canManage || occurrence.mine ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={t("careSkipWhen", { title, when: when(occurrence) })}
                      loading={act.busy}
                      onClick={() => {
                        act.mutate({
                          id: occurrence.id,
                          body: { action: "skip", revision: occurrence.revision },
                        });
                      }}
                      data-testid="care-skip"
                    >
                      {t("careSkip")}
                    </Button>
                  ) : null}
                  {activity.canManage ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={t("careChangeWhen", { title, when: when(occurrence) })}
                      onClick={() => {
                        setDialog({ kind: "change", occurrence });
                      }}
                      data-testid="care-change"
                    >
                      {t("careChange")}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t("careRecent")} headingLevel={2}>
        {activity.recent.length === 0 ? (
          <p className="text-body text-fg-muted">{t("careRecentNone")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line" data-testid="care-recent">
            {activity.recent.map((occurrence) => (
              <li
                key={occurrence.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
                data-testid="care-done"
              >
                <div className="flex flex-col gap-1">
                  <p className="flex flex-wrap items-center gap-2 text-body text-fg">
                    <span>{when(occurrence)}</span>
                    <CareStatus status={occurrence.status} />
                  </p>
                  <p className="text-helper text-fg-muted" data-testid="care-recorded">
                    {occurrence.status === "completed" && occurrence.completedAt
                      ? t("careCompletedBy", {
                          name: names.one(occurrence.completedBy),
                          when: completedAt(occurrence.completedAt),
                        })
                      : occurrence.skippedAt
                        ? t("careSkippedBy", {
                            name: names.one(occurrence.skippedBy),
                            when: completedAt(occurrence.skippedAt),
                          })
                        : null}
                    {occurrence.corrected ? ` · ${t("careCorrected")}` : ""}
                  </p>
                  {occurrence.note ? <p className="text-body text-fg">{occurrence.note}</p> : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  {activity.canManage || occurrence.recordedByMe ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={t("careReopenWhen", { title, when: when(occurrence) })}
                      loading={act.busy}
                      onClick={() => {
                        act.mutate({
                          id: occurrence.id,
                          body: { action: "reopen", revision: occurrence.revision },
                        });
                      }}
                      data-testid="care-reopen"
                    >
                      {t("careReopen")}
                    </Button>
                  ) : null}
                  {occurrence.status === "completed" &&
                  !activity.concealed &&
                  (activity.canManage || occurrence.recordedByMe) ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={t("careCorrectWhen", { title, when: when(occurrence) })}
                      onClick={() => {
                        setDialog({ kind: "correct", occurrence });
                      }}
                      data-testid="care-correct"
                    >
                      {t("careCorrect")}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {editing ? (
        <CareActivityForm
          homeId={activity.homeId}
          petId={activity.petId}
          today={activity.today}
          members={members}
          canMarkMedical={canMarkMedical}
          activity={activity}
          {...(editing.from ? { from: editing.from } : {})}
          onClose={() => {
            setEditing(null);
          }}
        />
      ) : null}
      {dialog?.kind === "change" ? (
        <ChangeOccurrenceDialog
          occurrence={dialog.occurrence}
          members={members}
          canEditSeries={activity.canEdit}
          onSeries={() => {
            setDialog(null);
            setEditing({ from: dialog.occurrence.scheduledOn });
          }}
          onClose={() => {
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.kind === "correct" ? (
        <CorrectDialog
          occurrence={dialog.occurrence}
          timeZone={activity.timeZone}
          onClose={() => {
            setDialog(null);
          }}
        />
      ) : null}
      {ending ? (
        <ConfirmDialog
          title={t("careEndTitle")}
          description={t("careEndExplanation")}
          confirmLabel={t("careEnd")}
          busy={setState.busy}
          error={setState.error}
          onConfirm={() => {
            setState.mutate("ended", {
              onSuccess: () => {
                setEnding(false);
              },
            });
          }}
          onClose={() => {
            setEnding(false);
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title={t("careDeleteTitle")}
          description={t("careDeleteExplanation")}
          confirmLabel={t("delete")}
          busy={remove.busy}
          error={remove.error}
          onConfirm={() => {
            remove.mutate(undefined);
          }}
          onClose={() => {
            setDeleting(false);
          }}
        />
      ) : null}
    </div>
  );
}

interface ChangeValues {
  scope: "occurrence" | "following";
  dueOn: string;
  time: string;
  members: string[];
}

/** Changes only this occurrence (date, time, responsible members), or opens "this and following". */
function ChangeOccurrenceDialog({
  occurrence,
  members,
  canEditSeries,
  onSeries,
  onClose,
}: {
  readonly occurrence: CareOccurrence;
  readonly members: readonly CareMember[];
  readonly canEditSeries: boolean;
  readonly onSeries: () => void;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Pets");
  const form = useForm<ChangeValues>({
    defaultValues: {
      scope: "occurrence",
      dueOn: occurrence.dueOn,
      time: occurrence.time ?? "",
      members: occurrence.members.filter((member): member is string => member !== null),
    },
  });
  const scope = useWatch({ control: form.control, name: "scope" });
  const save = usePetMutation(
    `pet-care-occurrence:${occurrence.id}`,
    (body: object) => sendPetRequest("POST", careOccurrenceEndpoint(occurrence.id), body),
    onClose,
  );
  const submit = (values: ChangeValues) => {
    if (values.scope === "following") {
      onSeries();
      return;
    }
    if (values.dueOn === "") {
      form.setError("dueOn", { message: "required" });
      form.setFocus("dueOn");
      return;
    }
    save.mutate({
      action: "update",
      revision: occurrence.revision,
      dueOn: values.dueOn,
      time: values.time === "" ? null : values.time,
      members: values.members,
    });
  };
  return (
    <Dialog open onClose={onClose} title={t("careChangeTitle")} closeLabel={t("close")}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void form.handleSubmit(submit)(event);
        }}
        data-testid="care-change-form"
      >
        <PetFailureAlert error={save.error} />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-body font-medium text-fg">{t("careScope")}</legend>
          <label className="flex items-center gap-2 text-body text-fg">
            <input type="radio" value="occurrence" {...form.register("scope")} />
            {t("careScopeOccurrence")}
          </label>
          {canEditSeries ? (
            <label className="flex items-center gap-2 text-body text-fg">
              <input
                type="radio"
                value="following"
                data-testid="care-scope-following"
                {...form.register("scope")}
              />
              {t("careScopeFollowing")}
            </label>
          ) : null}
        </fieldset>
        {scope === "occurrence" ? (
          <>
            <TextField
              type="date"
              label={t("careFieldDate")}
              required
              error={form.formState.errors.dueOn ? t("errorRequired") : undefined}
              data-testid="care-occurrence-date"
              {...form.register("dueOn")}
            />
            <TextField
              type="time"
              label={t("careFieldTime")}
              description={t("careFieldTimeHint")}
              {...form.register("time")}
            />
            <fieldset>
              <legend className="mb-1 text-body font-medium text-fg">
                {t("careFieldMembers")}
              </legend>
              <div className="flex flex-col gap-2">
                {members.map((member) => (
                  <Checkbox
                    key={member.id}
                    value={member.id}
                    label={member.name ?? t("memberUnnamed")}
                    {...form.register("members")}
                  />
                ))}
              </div>
            </fieldset>
          </>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" loading={save.busy} data-testid="care-change-save">
            {scope === "following" ? t("careScopeContinue") : t("save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

interface CorrectValues {
  date: string;
  time: string;
  note: string;
}

/** Corrects when the care was given, and the note. */
function CorrectDialog({
  occurrence,
  timeZone,
  onClose,
}: {
  readonly occurrence: CareOccurrence;
  readonly timeZone: string;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Pets");
  const at = zonedParts(occurrence.completedAt ?? new Date().toISOString(), timeZone);
  const form = useForm<CorrectValues>({
    defaultValues: { date: at.date, time: at.time, note: occurrence.note ?? "" },
  });
  const save = usePetMutation(
    `pet-care-occurrence:${occurrence.id}`,
    (body: object) => sendPetRequest("POST", careOccurrenceEndpoint(occurrence.id), body),
    onClose,
  );
  const submit = (values: CorrectValues) => {
    const instant = instantFromZoned(values.date, values.time, timeZone);
    if (!instant || new Date(instant).getTime() > Date.now()) {
      form.setError("time", { message: "invalid" });
      form.setFocus("time");
      return;
    }
    save.mutate({
      action: "correct",
      revision: occurrence.revision,
      completedAt: instant,
      note: values.note,
    });
  };
  return (
    <Dialog open onClose={onClose} title={t("careCorrectTitle")} closeLabel={t("close")}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void form.handleSubmit(submit)(event);
        }}
      >
        <PetFailureAlert error={save.error} />
        <TextField type="date" label={t("careFieldDoneDate")} required {...form.register("date")} />
        <TextField
          type="time"
          label={t("careFieldDoneTime")}
          required
          error={form.formState.errors.time ? t("careDoneTimeInvalid") : undefined}
          {...form.register("time")}
        />
        <TextArea
          label={t("careFieldNote")}
          description={t("optionalMax", { max: PET_CARE_LIMITS.note })}
          rows={2}
          {...form.register("note")}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" loading={save.busy}>
            {t("save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
