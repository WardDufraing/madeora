"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { careEndpoint, petEndpoint, sendPetRequest } from "@/pets/api";
import {
  createCareSchema,
  PET_CARE_LIMITS,
  petCareCategories,
  petCareFrequencies,
  petCareReminders,
  updateCareSchema,
  type PetCareCategory,
  type PetCareFrequency,
} from "@/pets/care-schema";
import type { CareActivity } from "@/pets/care-shapes";
import { careActivityPath } from "@/pets/format";

import type { CareMember } from "./care-parts";
import { PetFailureAlert } from "./pet-parts";
import { usePetMutation } from "./use-pet-mutation";
import { usePetTexts } from "./use-pet-texts";

interface FormValues {
  title: string;
  category: PetCareCategory;
  medical: boolean;
  instructions: string;
  reminder: string;
  changeSchedule: boolean;
  from: string;
  frequency: PetCareFrequency;
  interval: string;
  weekdays: string[];
  startsOn: string;
  endsOn: string;
  time: string;
  members: string[];
}

type Field = keyof FormValues;
const fieldNames: readonly Field[] = [
  "title",
  "category",
  "instructions",
  "reminder",
  "from",
  "frequency",
  "interval",
  "weekdays",
  "startsOn",
  "endsOn",
  "time",
  "members",
];

function isField(value: unknown): value is Field {
  return typeof value === "string" && (fieldNames as readonly string[]).includes(value);
}

const weekdayNumbers = [1, 2, 3, 4, 5, 6, 7] as const;

/**
 * Adds a care activity, or changes one (pet managers; medical manage too for medical details). The
 * title, category, instructions and reminder apply to the whole activity. The schedule is set when
 * the activity is added; changing it applies from a chosen date on ("this and following"), so the
 * care before that date keeps the schedule it had. A new activity opens its own page.
 */
export function CareActivityForm({
  homeId,
  petId,
  today,
  members,
  canMarkMedical,
  activity,
  from,
  onClose,
}: {
  readonly homeId: string;
  readonly petId: string;
  readonly today: string;
  readonly members: readonly CareMember[];
  /** Whether the person may add medical details (medical manage). */
  readonly canMarkMedical: boolean;
  /** Absent: a new activity. */
  readonly activity?: CareActivity;
  /** Editing from an occurrence: the schedule changes from its date on. */
  readonly from?: string;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Pets");
  const texts = usePetTexts();
  const router = useRouter();
  const [id] = useState(() => crypto.randomUUID());
  const schedule = activity?.schedule ?? null;
  const form = useForm<FormValues>({
    defaultValues: {
      title: activity?.title ?? "",
      category: activity?.category ?? "feeding",
      medical: activity?.medical ?? false,
      instructions: activity?.instructions ?? "",
      reminder: activity?.reminder === null || !activity ? "" : String(activity.reminder),
      changeSchedule: !activity || from !== undefined,
      from: from ?? today,
      frequency: schedule?.frequency ?? "daily",
      interval: String(schedule?.interval ?? 1),
      weekdays: (schedule?.weekdays ?? []).map(String),
      startsOn: from ?? (schedule && schedule.startsOn > today ? schedule.startsOn : today),
      endsOn: schedule?.endsOn ?? "",
      time: schedule?.time ?? "",
      members: (schedule?.members ?? []).filter((member): member is string => member !== null),
    },
  });
  const errors = form.formState.errors;
  const [category, frequency, changeSchedule] = useWatch({
    control: form.control,
    name: ["category", "frequency", "changeSchedule"],
  });
  const save = usePetMutation(
    `pet-care:${activity?.id ?? id}`,
    (body: object) =>
      activity
        ? sendPetRequest("PATCH", careEndpoint(activity.id), body)
        : sendPetRequest("POST", petEndpoint(petId, "care"), body),
    () => {
      onClose();
      if (!activity) router.push(careActivityPath(homeId, petId, id));
    },
  );
  const error = (field: Field) => {
    const issue = errors[field];
    return issue ? texts.field(issue.message) : undefined;
  };

  const submit = (values: FormValues) => {
    form.clearErrors();
    const fields = {
      title: values.title,
      category: values.category,
      medical: values.medical,
      instructions: values.instructions,
      reminder: values.reminder === "" ? null : Number(values.reminder),
    };
    const recurring = values.frequency !== "once";
    const scheduleFields = {
      frequency: values.frequency,
      interval: recurring ? Number(values.interval) : 1,
      weekdays: values.frequency === "weekly" ? values.weekdays.map(Number) : null,
      startsOn: values.startsOn,
      endsOn: recurring && values.endsOn !== "" ? values.endsOn : null,
      time: values.time === "" ? null : values.time,
      members: values.members,
    };
    const parsed = activity
      ? updateCareSchema.safeParse({
          revision: activity.revision,
          activity: fields,
          schedule: values.changeSchedule ? scheduleFields : null,
          from: values.changeSchedule ? values.from : null,
        })
      : createCareSchema.safeParse({ id, activity: fields, schedule: scheduleFields });
    if (!parsed.success) {
      let first: Field | null = null;
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] === "id" || issue.path[0] === "revision" ? null : issue.path[1];
        const field = isField(key) ? key : isField(issue.path[0]) ? issue.path[0] : null;
        if (field && !form.getFieldState(field).error) {
          const value = values[field];
          form.setError(field, {
            message:
              value === "" || (Array.isArray(value) && value.length === 0)
                ? "required"
                : issue.message,
          });
          first ??= field;
        }
      }
      if (first) form.setFocus(first);
      return;
    }
    save.mutate(parsed.data);
  };

  const medicalLocked = category === "medication";
  return (
    <Dialog
      open
      onClose={onClose}
      title={activity ? t("careEditTitle") : t("careAddTitle")}
      description={t("careExplanation")}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void form.handleSubmit(submit)(event);
        }}
        data-testid="care-form"
      >
        <PetFailureAlert error={save.error} />
        <TextField
          label={t("careFieldTitle")}
          description={t("requiredMax", { max: PET_CARE_LIMITS.title })}
          autoComplete="off"
          required
          error={error("title")}
          data-testid="care-title"
          {...form.register("title")}
        />
        <SelectField
          label={t("careFieldCategory")}
          options={petCareCategories
            // Medication is medical information: only for those who may add it.
            .filter((value) => canMarkMedical || value !== "medication")
            .map((value) => ({ value, label: texts.careCategory(value) }))}
          data-testid="care-category"
          {...form.register("category")}
        />
        {canMarkMedical ? (
          <Checkbox
            label={t("careFieldMedical")}
            description={
              medicalLocked ? t("careFieldMedicalMedication") : t("careFieldMedicalHint")
            }
            disabled={medicalLocked}
            readOnly={medicalLocked}
            checked={medicalLocked ? true : undefined}
            data-testid="care-medical"
            {...(medicalLocked ? {} : form.register("medical"))}
          />
        ) : null}
        <TextArea
          label={t("careFieldInstructions")}
          description={t("optionalMax", { max: PET_CARE_LIMITS.instructions })}
          rows={3}
          error={error("instructions")}
          {...form.register("instructions")}
        />
        <SelectField
          label={t("careFieldReminder")}
          description={t("careFieldReminderHint")}
          options={[
            { value: "", label: t("careReminderOff") },
            ...petCareReminders.map((value) => ({
              value: String(value),
              label: t("careReminderBefore", { minutes: value }),
            })),
          ]}
          data-testid="care-reminder"
          {...form.register("reminder")}
        />

        {activity ? (
          <Checkbox
            label={t("careChangeSchedule")}
            description={t("careChangeScheduleHint")}
            data-testid="care-change-schedule"
            {...form.register("changeSchedule")}
          />
        ) : null}

        {changeSchedule ? (
          <fieldset className="flex flex-col gap-4">
            <legend className="mb-2 text-body font-semibold text-fg">{t("careSchedule")}</legend>
            {activity ? (
              <TextField
                type="date"
                label={t("careFieldFrom")}
                description={t("careFieldFromHint")}
                required
                error={error("from")}
                data-testid="care-from"
                {...form.register("from")}
              />
            ) : null}
            <SelectField
              label={t("careFieldFrequency")}
              options={petCareFrequencies.map((value) => ({
                value,
                label: texts.frequency(value),
              }))}
              data-testid="care-frequency"
              {...form.register("frequency")}
            />
            {frequency !== "once" ? (
              <TextField
                type="number"
                inputMode="numeric"
                min={1}
                max={PET_CARE_LIMITS.maxInterval}
                label={t("careFieldInterval")}
                description={t("careFieldIntervalHint")}
                error={error("interval")}
                {...form.register("interval")}
              />
            ) : null}
            {frequency === "weekly" ? (
              <fieldset aria-describedby={errors.weekdays ? "care-weekdays-error" : undefined}>
                <legend className="mb-1 text-body font-medium text-fg">
                  {t("careFieldWeekdays")}
                </legend>
                <div className="flex flex-wrap gap-3">
                  {weekdayNumbers.map((day) => (
                    <Checkbox
                      key={day}
                      value={String(day)}
                      label={new Intl.DateTimeFormat(texts.locale, {
                        weekday: "short",
                        timeZone: "UTC",
                      }).format(new Date(Date.UTC(2024, 0, day)))}
                      {...form.register("weekdays")}
                    />
                  ))}
                </div>
                {errors.weekdays ? (
                  <p id="care-weekdays-error" className="mt-1 text-helper text-danger">
                    {t("careWeekdaysRequired")}
                  </p>
                ) : null}
              </fieldset>
            ) : null}
            <TextField
              type="date"
              label={frequency === "once" ? t("careFieldDate") : t("careFieldStart")}
              required
              error={error("startsOn")}
              data-testid="care-starts"
              {...form.register("startsOn")}
            />
            {frequency !== "once" ? (
              <TextField
                type="date"
                label={t("careFieldEnd")}
                description={t("optional")}
                error={error("endsOn")}
                {...form.register("endsOn")}
              />
            ) : null}
            <TextField
              type="time"
              label={t("careFieldTime")}
              description={t("careFieldTimeHint")}
              error={error("time")}
              data-testid="care-time"
              {...form.register("time")}
            />
            <fieldset>
              <legend className="mb-1 text-body font-medium text-fg">
                {t("careFieldMembers")}
              </legend>
              <p className="mb-2 text-helper text-fg-muted">{t("careFieldMembersHint")}</p>
              <div className="flex flex-col gap-2" data-testid="care-members">
                {members.map((member) => (
                  <Checkbox
                    key={member.id}
                    value={member.id}
                    label={
                      member.isSelf
                        ? t("memberYouNamed", { name: member.name ?? t("memberUnnamed") })
                        : (member.name ?? t("memberUnnamed"))
                    }
                    {...form.register("members")}
                  />
                ))}
              </div>
            </fieldset>
          </fieldset>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" loading={save.busy} data-testid="care-save">
            {activity ? t("save") : t("careAddSave")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
