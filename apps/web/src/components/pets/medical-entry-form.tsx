"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { medicalEntryEndpoint, petEndpoint, sendPetRequest, type MedicalEntry } from "@/pets/api";
import { medicalEntryPath } from "@/pets/format";
import {
  createEntrySchema,
  PET_LIMITS,
  petEventTypes,
  updateEntrySchema,
  type PetEventType,
} from "@/pets/schema";

import { PetFailureAlert } from "./pet-parts";
import { usePetMutation } from "./use-pet-mutation";
import { usePetTexts } from "./use-pet-texts";

interface FormValues {
  type: PetEventType;
  date: string;
  title: string;
  veterinarian: string;
  location: string;
  treatment: string;
  notes: string;
  followUpDate: string;
}

type Field = keyof FormValues;
const fields: readonly Field[] = [
  "type",
  "date",
  "title",
  "veterinarian",
  "location",
  "treatment",
  "notes",
  "followUpDate",
];

function isField(value: unknown): value is Field {
  return typeof value === "string" && (fields as readonly string[]).includes(value);
}

/** `days` after an ISO date. */
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** The earliest event date: the pet's birth date when known, else 1 January 1980. */
export function earliestEntryDate(birthDate: string | null): string {
  return birthDate && birthDate > "1980-01-01" ? birthDate : "1980-01-01";
}

/**
 * Adds a medical entry, or corrects one in place (medical managers): a type and an event date are
 * required, the rest optional; the follow-up is on or after the event. An event after today is an
 * upcoming appointment. A new entry opens its own page, where documents are added.
 */
export function MedicalEntryForm({
  homeId,
  petId,
  birthDate,
  today,
  entry,
  onClose,
}: {
  readonly homeId: string;
  readonly petId: string;
  readonly birthDate: string | null;
  readonly today: string;
  /** Absent: a new entry. */
  readonly entry?: MedicalEntry;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Pets");
  const texts = usePetTexts();
  const router = useRouter();
  const [id] = useState(() => crypto.randomUUID());
  const form = useForm<FormValues>({
    defaultValues: {
      type: entry?.type ?? "vet_visit",
      date: entry?.date ?? today,
      title: entry?.title ?? "",
      veterinarian: entry?.veterinarian ?? "",
      location: entry?.location ?? "",
      treatment: entry?.treatment ?? "",
      notes: entry?.notes ?? "",
      followUpDate: entry?.followUpDate ?? "",
    },
  });
  const errors = form.formState.errors;
  const save = usePetMutation(
    `pet-entry:${entry?.id ?? id}`,
    (body: object) =>
      entry
        ? sendPetRequest("PATCH", medicalEntryEndpoint(entry.id), body)
        : sendPetRequest("POST", petEndpoint(petId, "medical-entries"), body),
    () => {
      onClose();
      if (!entry) router.push(medicalEntryPath(homeId, petId, id));
    },
  );
  const earliest = earliestEntryDate(birthDate);
  const latest = addDays(today, PET_LIMITS.entryDaysAhead);
  const error = (field: Field) => (errors[field] ? texts.field(errors[field].message) : undefined);

  const submit = (values: FormValues) => {
    form.clearErrors();
    let first: Field | null = null;
    if (values.date !== "" && (values.date < earliest || values.date > latest)) {
      form.setError("date", { message: "outOfRange" });
      first = "date";
    }
    const fields = {
      type: values.type,
      date: values.date,
      title: values.title,
      veterinarian: values.veterinarian,
      location: values.location,
      treatment: values.treatment,
      notes: values.notes,
      followUpDate: values.followUpDate === "" ? null : values.followUpDate,
    };
    const parsed = entry
      ? updateEntrySchema.safeParse({ revision: entry.revision, entry: fields })
      : createEntrySchema.safeParse({ id, entry: fields });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] === "entry" ? issue.path[1] : issue.path[0];
        if (isField(key) && !form.getFieldState(key).error) {
          form.setError(key, { message: values[key] === "" ? "required" : issue.message });
          first ??= key;
        }
      }
    }
    if (first) {
      form.setFocus(first);
      return;
    }
    if (parsed.success) save.mutate(parsed.data);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={entry ? t("editEntryTitle") : t("addEntryTitle")}
      description={t("entryExplanation")}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void form.handleSubmit(submit)(event);
        }}
        data-testid="pet-entry-form"
      >
        <PetFailureAlert error={save.error} />
        <SelectField
          label={t("fieldEventType")}
          options={petEventTypes.map((value) => ({ value, label: texts.eventType(value) }))}
          data-testid="pet-entry-type"
          {...form.register("type")}
        />
        <TextField
          type="date"
          label={t("fieldEventDate")}
          description={t("fieldEventDateHint")}
          min={earliest}
          max={latest}
          required
          error={error("date")}
          data-testid="pet-entry-date"
          {...form.register("date")}
        />
        <TextField
          label={t("fieldEntryTitle")}
          description={t("optionalMax", { max: PET_LIMITS.short })}
          autoComplete="off"
          error={error("title")}
          data-testid="pet-entry-title"
          {...form.register("title")}
        />
        <TextField
          label={t("fieldVeterinarian")}
          autoComplete="off"
          error={error("veterinarian")}
          {...form.register("veterinarian")}
        />
        <TextField
          label={t("fieldLocation")}
          autoComplete="off"
          error={error("location")}
          {...form.register("location")}
        />
        <TextArea
          label={t("fieldTreatment")}
          description={t("optionalMax", { max: PET_LIMITS.long })}
          rows={3}
          error={error("treatment")}
          {...form.register("treatment")}
        />
        <TextArea
          label={t("fieldEntryNotes")}
          description={t("optionalMax", { max: PET_LIMITS.long })}
          rows={3}
          error={error("notes")}
          {...form.register("notes")}
        />
        <TextField
          type="date"
          label={t("fieldFollowUp")}
          description={t("fieldFollowUpHint")}
          error={error("followUpDate")}
          data-testid="pet-entry-follow-up"
          {...form.register("followUpDate")}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" loading={save.busy} data-testid="pet-entry-save">
            {entry ? t("save") : t("addEntrySave")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
