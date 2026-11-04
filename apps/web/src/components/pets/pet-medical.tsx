"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import {
  petEndpoint,
  sendPetRequest,
  type MedicalEntry,
  type PetDetail,
  type PetMedical,
} from "@/pets/api";
import { medicalEntryPath } from "@/pets/format";
import {
  PET_LIMITS,
  putMedicalSchema,
  type MedicalNoneField,
  type MedicalUnknownField,
} from "@/pets/schema";

import { MedicalEntryForm } from "./medical-entry-form";
import { NotEntered, PetFailureAlert, PetValue } from "./pet-parts";
import { usePetMutation } from "./use-pet-mutation";
import { usePetTexts } from "./use-pet-texts";

/**
 * A pet's Medical section (S31), rendered only for someone with medical view: the sensitive
 * details, Upcoming appointments (entries dated after the Home's today, soonest first) and the
 * History timeline (newest first). Medical managers edit the details and add entries.
 */
export function PetMedicalSection({
  pet,
  medical,
}: {
  readonly pet: PetDetail;
  readonly medical: PetMedical;
}) {
  const t = useTranslations("Pets");
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const manage = medical.level === "manage";
  const details = medical.details;
  const show = (field: MedicalUnknownField | null, value: string | null) => {
    if (value !== null) return value;
    if (field && (details.none as readonly string[]).includes(field)) return t("none");
    if (field && details.unknown.includes(field)) return t("unknown");
    return <NotEntered />;
  };
  const upcoming = medical.entries
    .filter((entry) => entry.date > medical.today)
    .sort((a, b) => a.date.localeCompare(b.date));
  const history = medical.entries
    .filter((entry) => entry.date <= medical.today)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));

  return (
    <section
      aria-labelledby="pet-medical-heading"
      className="flex flex-col gap-6"
      data-testid="pet-medical"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="pet-medical-heading" className="text-section-title font-semibold text-fg">
          {t("sectionMedical")}
        </h2>
        <p className="text-helper text-fg-muted">
          {manage ? t("medicalLevelManage") : t("medicalLevelView")}
        </p>
      </div>

      <Card
        title={t("sectionSensitive")}
        headingLevel={3}
        action={
          manage ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setEditing(true);
              }}
              data-testid="pet-medical-edit"
            >
              {t("editDetails")}
            </Button>
          ) : null
        }
      >
        <dl className="flex flex-col gap-3" data-testid="pet-medical-details">
          <PetValue label={t("fieldAllergies")} testId="pet-allergies">
            {show("allergies", details.allergies)}
          </PetValue>
          <PetValue label={t("fieldMedications")} testId="pet-medications">
            {show("medications", details.medications)}
          </PetValue>
          <PetValue label={t("fieldMicrochip")}>{show("microchip", details.microchip)}</PetValue>
          <PetValue label={t("fieldRegistration")}>
            {show("registration", details.registration)}
          </PetValue>
          <PetValue label={t("fieldIdentificationNotes")}>
            {show(null, details.identificationNotes)}
          </PetValue>
          <PetValue label={t("fieldMedicalNotes")}>{show(null, details.medicalNotes)}</PetValue>
        </dl>
      </Card>

      {manage ? (
        <div>
          <Button
            onClick={() => {
              setAdding(true);
            }}
            data-testid="pet-entry-new"
          >
            {t("addEntry")}
          </Button>
        </div>
      ) : null}

      <Card title={t("sectionUpcoming")} headingLevel={3}>
        {upcoming.length === 0 ? (
          <p className="text-body text-fg-muted">{t("noUpcoming")}</p>
        ) : (
          <EntryList homeId={pet.homeId} petId={pet.id} entries={upcoming} testId="pet-upcoming" />
        )}
      </Card>

      <Card title={t("sectionHistory")} headingLevel={3}>
        {history.length === 0 ? (
          <p className="text-body text-fg-muted">{t("noHistory")}</p>
        ) : (
          <EntryList homeId={pet.homeId} petId={pet.id} entries={history} testId="pet-history" />
        )}
      </Card>

      {editing ? (
        <MedicalDetailsForm
          petId={pet.id}
          medical={medical}
          onClose={() => {
            setEditing(false);
          }}
        />
      ) : null}
      {adding ? (
        <MedicalEntryForm
          homeId={pet.homeId}
          petId={pet.id}
          birthDate={pet.birthDate}
          today={medical.today}
          onClose={() => {
            setAdding(false);
          }}
        />
      ) : null}
    </section>
  );
}

function EntryList({
  homeId,
  petId,
  entries,
  testId,
}: {
  readonly homeId: string;
  readonly petId: string;
  readonly entries: readonly MedicalEntry[];
  readonly testId: string;
}) {
  const t = useTranslations("Pets");
  const texts = usePetTexts();
  return (
    <ol className="flex flex-col divide-y divide-line" data-testid={testId}>
      {entries.map((entry) => (
        <li key={entry.id} className="flex flex-col gap-0.5 py-3 first:pt-0 last:pb-0">
          <Link
            href={medicalEntryPath(homeId, petId, entry.id)}
            className="text-body font-semibold text-accent-fg underline"
            data-testid="pet-entry-link"
          >
            <bdi>{entry.title ?? texts.eventType(entry.type)}</bdi>
          </Link>
          <span className="text-helper text-fg-muted">
            {texts.eventType(entry.type)}
            {" · "}
            <time dateTime={entry.date}>{texts.date(entry.date)}</time>
            {entry.attachments.length > 0
              ? ` · ${t("attachmentCount", { count: entry.attachments.length })}`
              : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

type DetailState = "value" | "unknown" | "none";

interface DetailValues {
  allergies: string;
  allergiesState: DetailState;
  medications: string;
  medicationsState: DetailState;
  microchip: string;
  microchipState: DetailState;
  registration: string;
  registrationState: DetailState;
  identificationNotes: string;
  medicalNotes: string;
}

type DetailField =
  | "allergies"
  | "medications"
  | "microchip"
  | "registration"
  | "identificationNotes"
  | "medicalNotes";
const detailFields: readonly DetailField[] = [
  "allergies",
  "medications",
  "microchip",
  "registration",
  "identificationNotes",
  "medicalNotes",
];

function isDetailField(value: unknown): value is DetailField {
  return typeof value === "string" && (detailFields as readonly string[]).includes(value);
}

/**
 * Edits the sensitive details (medical managers). Allergies and medications can be entered, left
 * empty, or recorded explicitly as None or Unknown; microchip and registration numbers as Unknown.
 * Empty is never None.
 */
function MedicalDetailsForm({
  petId,
  medical,
  onClose,
}: {
  readonly petId: string;
  readonly medical: PetMedical;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Pets");
  const texts = usePetTexts();
  const details = medical.details;
  const state = (field: MedicalUnknownField): DetailState =>
    (details.none as readonly string[]).includes(field)
      ? "none"
      : details.unknown.includes(field)
        ? "unknown"
        : "value";
  const form = useForm<DetailValues>({
    defaultValues: {
      allergies: details.allergies ?? "",
      allergiesState: state("allergies"),
      medications: details.medications ?? "",
      medicationsState: state("medications"),
      microchip: details.microchip ?? "",
      microchipState: state("microchip"),
      registration: details.registration ?? "",
      registrationState: state("registration"),
      identificationNotes: details.identificationNotes ?? "",
      medicalNotes: details.medicalNotes ?? "",
    },
  });
  const errors = form.formState.errors;
  const [allergiesState, medicationsState, microchipState, registrationState] = useWatch({
    control: form.control,
    name: ["allergiesState", "medicationsState", "microchipState", "registrationState"],
  });
  const save = usePetMutation(
    `pet-medical:${petId}`,
    (body: object) => sendPetRequest("PUT", petEndpoint(petId, "medical"), body),
    onClose,
  );
  const error = (field: DetailField) =>
    errors[field] ? texts.field(errors[field].message) : undefined;
  const stateOptions = (withNone: boolean) => [
    { value: "value", label: t("stateValue") },
    ...(withNone ? [{ value: "none", label: t("none") }] : []),
    { value: "unknown", label: t("unknown") },
  ];

  const submit = (values: DetailValues) => {
    form.clearErrors();
    const unknown: MedicalUnknownField[] = [];
    const none: MedicalNoneField[] = [];
    const text = (field: MedicalUnknownField, current: DetailState, value: string) => {
      if (current === "unknown") unknown.push(field);
      if (current === "none" && (field === "allergies" || field === "medications")) {
        none.push(field);
      }
      return current === "value" ? value : null;
    };
    const body = {
      revision: details.revision,
      details: {
        allergies: text("allergies", values.allergiesState, values.allergies),
        medications: text("medications", values.medicationsState, values.medications),
        microchip: text("microchip", values.microchipState, values.microchip),
        registration: text("registration", values.registrationState, values.registration),
        identificationNotes: values.identificationNotes,
        medicalNotes: values.medicalNotes,
        unknown,
        none,
      },
    };
    const parsed = putMedicalSchema.safeParse(body);
    if (!parsed.success) {
      let first: DetailField | null = null;
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] === "details" ? issue.path[1] : issue.path[0];
        if (isDetailField(key) && !form.getFieldState(key).error) {
          form.setError(key, { message: issue.message });
          first ??= key;
        }
      }
      if (first) form.setFocus(first);
      return;
    }
    save.mutate(parsed.data);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("editDetailsTitle")}
      description={t("editDetailsExplanation")}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void form.handleSubmit(submit)(event);
        }}
        data-testid="pet-medical-form"
      >
        <PetFailureAlert error={save.error} />
        <SelectField
          label={t("fieldAllergiesState")}
          options={stateOptions(true)}
          data-testid="pet-allergies-state"
          {...form.register("allergiesState")}
        />
        {allergiesState === "value" ? (
          <TextArea
            label={t("fieldAllergiesText")}
            description={t("optionalMax", { max: PET_LIMITS.long })}
            rows={2}
            error={error("allergies")}
            data-testid="pet-field-allergies"
            {...form.register("allergies")}
          />
        ) : null}
        <SelectField
          label={t("fieldMedicationsState")}
          options={stateOptions(true)}
          data-testid="pet-medications-state"
          {...form.register("medicationsState")}
        />
        {medicationsState === "value" ? (
          <TextArea
            label={t("fieldMedicationsText")}
            description={t("optionalMax", { max: PET_LIMITS.long })}
            rows={2}
            error={error("medications")}
            data-testid="pet-field-medications"
            {...form.register("medications")}
          />
        ) : null}
        <SelectField
          label={t("fieldMicrochipState")}
          options={stateOptions(false)}
          {...form.register("microchipState")}
        />
        {microchipState === "value" ? (
          <TextField
            label={t("fieldMicrochip")}
            autoComplete="off"
            error={error("microchip")}
            {...form.register("microchip")}
          />
        ) : null}
        <SelectField
          label={t("fieldRegistrationState")}
          options={stateOptions(false)}
          {...form.register("registrationState")}
        />
        {registrationState === "value" ? (
          <TextField
            label={t("fieldRegistration")}
            autoComplete="off"
            error={error("registration")}
            {...form.register("registration")}
          />
        ) : null}
        <TextArea
          label={t("fieldIdentificationNotes")}
          description={t("optionalMax", { max: PET_LIMITS.identificationNotes })}
          rows={2}
          error={error("identificationNotes")}
          {...form.register("identificationNotes")}
        />
        <TextArea
          label={t("fieldMedicalNotes")}
          description={t("optionalMax", { max: PET_LIMITS.long })}
          rows={3}
          error={error("medicalNotes")}
          {...form.register("medicalNotes")}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" loading={save.busy} data-testid="pet-medical-save">
            {t("save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
