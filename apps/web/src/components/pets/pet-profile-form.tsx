"use client";

import { useTranslations } from "next-intl";
import { useForm, useWatch } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { petEndpoint, sendPetRequest, type PetDetail } from "@/pets/api";
import { parseDecimal } from "@/pets/format";
import {
  PET_LIMITS,
  petSpecies,
  petWeightUnits,
  updatePetSchema,
  type PetSpecies,
  type PetUnknownField,
  type PetWeightUnit,
} from "@/pets/schema";

import { PetFailureAlert } from "./pet-parts";
import { unitKey } from "./pet-profile";
import { usePetMutation } from "./use-pet-mutation";
import { usePetTexts } from "./use-pet-texts";

/** "" is not entered; "unknown" is explicitly Unknown. */
type Choice<T extends string> = "" | "unknown" | T;

interface FormValues {
  name: string;
  species: Choice<PetSpecies>;
  speciesLabel: string;
  breed: string;
  breedUnknown: boolean;
  birthMode: "" | "unknown" | "date" | "age";
  birthDate: string;
  ageYears: string;
  ageMonths: string;
  ageRecordedOn: string;
  sex: Choice<"female" | "male">;
  neutered: Choice<"yes" | "no">;
  weight: string;
  weightUnit: PetWeightUnit;
  weightRecordedOn: string;
  weightUnknown: boolean;
  vetName: string;
  vetClinic: string;
  vetPhone: string;
  vetEmail: string;
  vetAddress: string;
  diet: string;
  dietUnknown: boolean;
  careInstructions: string;
  notes: string;
}

type Field = keyof FormValues;

/** Where a schema issue (by its profile key) is shown. */
const issueField: Readonly<Record<string, Field>> = {
  name: "name",
  species: "species",
  speciesLabel: "speciesLabel",
  breed: "breed",
  birthDate: "birthDate",
  ageYears: "ageYears",
  ageMonths: "ageMonths",
  ageRecordedOn: "ageRecordedOn",
  weight: "weight",
  weightUnit: "weight",
  weightRecordedOn: "weightRecordedOn",
  vetName: "vetName",
  vetClinic: "vetClinic",
  vetPhone: "vetPhone",
  vetEmail: "vetEmail",
  vetAddress: "vetAddress",
  diet: "diet",
  careInstructions: "careInstructions",
  notes: "notes",
};

function defaults(pet: PetDetail): FormValues {
  const unknown = (field: PetUnknownField) => pet.unknown.includes(field);
  const hasAge = pet.ageYears !== null || pet.ageMonths !== null;
  return {
    name: pet.name,
    species: pet.species ?? (unknown("species") ? "unknown" : ""),
    speciesLabel: pet.speciesLabel ?? "",
    breed: pet.breed ?? "",
    breedUnknown: unknown("breed"),
    birthMode: pet.birthDate ? "date" : hasAge ? "age" : unknown("birth") ? "unknown" : "",
    birthDate: pet.birthDate ?? "",
    ageYears: pet.ageYears === null ? "" : String(pet.ageYears),
    ageMonths: pet.ageMonths === null ? "" : String(pet.ageMonths),
    ageRecordedOn: pet.ageRecordedOn ?? pet.today,
    sex: pet.sex ?? (unknown("sex") ? "unknown" : ""),
    neutered:
      pet.neutered === null ? (unknown("neutered") ? "unknown" : "") : pet.neutered ? "yes" : "no",
    weight: pet.weight === null ? "" : String(pet.weight),
    weightUnit: pet.weightUnit ?? "kg",
    weightRecordedOn: pet.weightRecordedOn ?? "",
    weightUnknown: unknown("weight"),
    vetName: pet.vetName ?? "",
    vetClinic: pet.vetClinic ?? "",
    vetPhone: pet.vetPhone ?? "",
    vetEmail: pet.vetEmail ?? "",
    vetAddress: pet.vetAddress ?? "",
    diet: pet.diet ?? "",
    dietUnknown: unknown("diet"),
    careInstructions: pet.careInstructions ?? "",
    notes: pet.notes ?? "",
  };
}

function whole(text: string): number | null | "invalid" {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return /^\d{1,3}$/u.test(trimmed) ? Number(trimmed) : "invalid";
}

/**
 * Edits a pet's basic profile (pet managers): every field optional but the name. Species, breed,
 * birth or age, sex, neutered, weight and diet can be left empty (not entered) or marked Unknown.
 * A birth date or an approximate age with the date it was true, never both. Errors are shown at
 * their fields; the database checks everything again, with the revision the form started from.
 */
export function PetProfileForm({
  pet,
  onClose,
}: {
  readonly pet: PetDetail;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Pets");
  const texts = usePetTexts();
  const form = useForm<FormValues>({ defaultValues: defaults(pet) });
  const errors = form.formState.errors;
  const [species, birthMode, breedUnknown, weightUnknown, dietUnknown] = useWatch({
    control: form.control,
    name: ["species", "birthMode", "breedUnknown", "weightUnknown", "dietUnknown"],
  });
  const save = usePetMutation(
    `pet:${pet.id}`,
    (body: object) => sendPetRequest("PATCH", petEndpoint(pet.id), body),
    onClose,
  );
  const error = (field: Field) => {
    const message = errors[field]?.message;
    return errors[field] ? texts.field(message) : undefined;
  };

  const submit = (values: FormValues) => {
    form.clearErrors();
    const marked: Field[] = [];
    const mark = (field: Field, message: string) => {
      form.setError(field, { message });
      marked.push(field);
    };
    const unknown: PetUnknownField[] = [];
    if (values.species === "unknown") unknown.push("species");
    if (values.breedUnknown) unknown.push("breed");
    if (values.birthMode === "unknown") unknown.push("birth");
    if (values.sex === "unknown") unknown.push("sex");
    if (values.neutered === "unknown") unknown.push("neutered");
    if (values.weightUnknown) unknown.push("weight");
    if (values.dietUnknown) unknown.push("diet");

    const ageYears = values.birthMode === "age" ? whole(values.ageYears) : null;
    const ageMonths = values.birthMode === "age" ? whole(values.ageMonths) : null;
    if (ageYears === "invalid") mark("ageYears", "invalid");
    if (ageMonths === "invalid") mark("ageMonths", "invalid");
    if (values.birthMode === "age" && ageYears === null && ageMonths === null) {
      mark("ageYears", "required");
    }
    if (values.birthMode === "date" && values.birthDate === "") mark("birthDate", "required");
    if (values.birthMode === "date" && values.birthDate > pet.today) mark("birthDate", "future");
    let weight: number | null = null;
    if (!values.weightUnknown && values.weight.trim() !== "") {
      weight = parseDecimal(values.weight);
      if (weight === null) mark("weight", "invalid");
    }
    if (weight !== null && values.weightRecordedOn > pet.today) {
      mark("weightRecordedOn", "future");
    }
    if (values.birthMode === "age" && values.ageRecordedOn > pet.today) {
      mark("ageRecordedOn", "future");
    }

    const age = values.birthMode === "age";
    const profile = {
      name: values.name,
      species: values.species === "" || values.species === "unknown" ? null : values.species,
      speciesLabel: values.species === "other" ? values.speciesLabel : null,
      breed: values.breedUnknown ? null : values.breed,
      birthDate: values.birthMode === "date" && values.birthDate !== "" ? values.birthDate : null,
      ageYears: age && typeof ageYears === "number" ? ageYears : null,
      ageMonths: age && typeof ageMonths === "number" ? ageMonths : null,
      ageRecordedOn: age && values.ageRecordedOn !== "" ? values.ageRecordedOn : null,
      sex: values.sex === "" || values.sex === "unknown" ? null : values.sex,
      neutered: values.neutered === "yes" ? true : values.neutered === "no" ? false : null,
      weight,
      weightUnit: weight === null ? null : values.weightUnit,
      weightRecordedOn:
        weight !== null && values.weightRecordedOn !== "" ? values.weightRecordedOn : null,
      vetName: values.vetName,
      vetClinic: values.vetClinic,
      vetPhone: values.vetPhone,
      vetEmail: values.vetEmail,
      vetAddress: values.vetAddress,
      diet: values.dietUnknown ? null : values.diet,
      careInstructions: values.careInstructions,
      notes: values.notes,
      unknown,
    };
    const parsed = updatePetSchema.safeParse({ revision: pet.revision, profile });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] === "profile" ? issue.path[1] : issue.path[0];
        const field = typeof key === "string" ? issueField[key] : undefined;
        if (field && !form.getFieldState(field).error) mark(field, issue.message);
      }
    }
    const [first] = marked;
    if (first) {
      form.setFocus(first);
      return;
    }
    if (parsed.success) save.mutate(parsed.data);
  };

  const choice = (value: string, label: string) => ({ value, label });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("editProfileTitle", { name: pet.name })}
      closeLabel={t("close")}
    >
      <form
        noValidate
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          void form.handleSubmit(submit)(event);
        }}
        data-testid="pet-profile-form"
      >
        <PetFailureAlert error={save.error} />
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-section-title font-semibold text-fg">
            {t("sectionIdentity")}
          </legend>
          <TextField
            label={t("fieldName")}
            description={t("fieldNameHint", { max: PET_LIMITS.name })}
            autoComplete="off"
            required
            error={error("name")}
            data-testid="pet-field-name"
            {...form.register("name")}
          />
          <SelectField
            label={t("fieldSpecies")}
            options={[
              choice("", t("notEntered")),
              ...petSpecies.map((value) => choice(value, texts.species(value, null))),
              choice("unknown", t("unknown")),
            ]}
            error={error("species")}
            data-testid="pet-field-species"
            {...form.register("species")}
          />
          {species === "other" ? (
            <TextField
              label={t("fieldSpeciesLabel")}
              description={t("optionalMax", { max: PET_LIMITS.short })}
              autoComplete="off"
              error={error("speciesLabel")}
              data-testid="pet-field-species-label"
              {...form.register("speciesLabel")}
            />
          ) : null}
          <TextField
            label={t("fieldBreed")}
            description={t("optionalMax", { max: PET_LIMITS.short })}
            autoComplete="off"
            disabled={breedUnknown}
            error={error("breed")}
            data-testid="pet-field-breed"
            {...form.register("breed")}
          />
          <Checkbox
            label={t("markUnknown", { field: t("fieldBreed") })}
            data-testid="pet-field-breed-unknown"
            {...form.register("breedUnknown")}
          />
          <SelectField
            label={t("fieldBirth")}
            options={[
              choice("", t("notEntered")),
              choice("date", t("birthModeDate")),
              choice("age", t("birthModeAge")),
              choice("unknown", t("unknown")),
            ]}
            data-testid="pet-field-birth-mode"
            {...form.register("birthMode")}
          />
          {birthMode === "date" ? (
            <TextField
              type="date"
              label={t("fieldBirthDate")}
              max={pet.today}
              error={error("birthDate")}
              data-testid="pet-field-birth-date"
              {...form.register("birthDate")}
            />
          ) : null}
          {birthMode === "age" ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField
                label={t("fieldAgeYears")}
                inputMode="numeric"
                autoComplete="off"
                error={error("ageYears")}
                data-testid="pet-field-age-years"
                {...form.register("ageYears")}
              />
              <TextField
                label={t("fieldAgeMonths")}
                inputMode="numeric"
                autoComplete="off"
                error={error("ageMonths")}
                data-testid="pet-field-age-months"
                {...form.register("ageMonths")}
              />
              <TextField
                type="date"
                label={t("fieldAgeRecordedOn")}
                max={pet.today}
                error={error("ageRecordedOn")}
                data-testid="pet-field-age-recorded"
                {...form.register("ageRecordedOn")}
              />
            </div>
          ) : null}
          <SelectField
            label={t("fieldSex")}
            options={[
              choice("", t("notEntered")),
              choice("female", t("sexFemale")),
              choice("male", t("sexMale")),
              choice("unknown", t("unknown")),
            ]}
            data-testid="pet-field-sex"
            {...form.register("sex")}
          />
          <SelectField
            label={t("fieldNeutered")}
            options={[
              choice("", t("notEntered")),
              choice("yes", t("yes")),
              choice("no", t("no")),
              choice("unknown", t("unknown")),
            ]}
            data-testid="pet-field-neutered"
            {...form.register("neutered")}
          />
        </fieldset>

        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-section-title font-semibold text-fg">
            {t("sectionHealthBasics")}
          </legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              label={t("fieldWeight")}
              description={t("fieldWeightHint")}
              inputMode="decimal"
              autoComplete="off"
              disabled={weightUnknown}
              error={error("weight")}
              data-testid="pet-field-weight"
              {...form.register("weight")}
            />
            <SelectField
              label={t("fieldWeightUnit")}
              options={petWeightUnits.map((unit) => choice(unit, t(unitKey[unit])))}
              disabled={weightUnknown}
              data-testid="pet-field-weight-unit"
              {...form.register("weightUnit")}
            />
            <TextField
              type="date"
              label={t("fieldWeightRecordedOn")}
              max={pet.today}
              disabled={weightUnknown}
              error={error("weightRecordedOn")}
              data-testid="pet-field-weight-recorded"
              {...form.register("weightRecordedOn")}
            />
          </div>
          <Checkbox
            label={t("markUnknown", { field: t("fieldWeight") })}
            data-testid="pet-field-weight-unknown"
            {...form.register("weightUnknown")}
          />
        </fieldset>

        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-section-title font-semibold text-fg">
            {t("sectionVet")}
          </legend>
          <TextField
            label={t("fieldVetName")}
            autoComplete="off"
            error={error("vetName")}
            {...form.register("vetName")}
          />
          <TextField
            label={t("fieldVetClinic")}
            autoComplete="off"
            error={error("vetClinic")}
            {...form.register("vetClinic")}
          />
          <TextField
            type="tel"
            label={t("fieldVetPhone")}
            autoComplete="off"
            error={error("vetPhone")}
            data-testid="pet-field-vet-phone"
            {...form.register("vetPhone")}
          />
          <TextField
            type="email"
            label={t("fieldVetEmail")}
            autoComplete="off"
            error={error("vetEmail")}
            data-testid="pet-field-vet-email"
            {...form.register("vetEmail")}
          />
          <TextArea
            label={t("fieldVetAddress")}
            rows={2}
            error={error("vetAddress")}
            {...form.register("vetAddress")}
          />
        </fieldset>

        <fieldset className="flex flex-col gap-4">
          <legend className="mb-2 text-section-title font-semibold text-fg">
            {t("sectionCare")}
          </legend>
          <TextArea
            label={t("fieldDiet")}
            description={t("optionalMax", { max: PET_LIMITS.long })}
            rows={3}
            disabled={dietUnknown}
            error={error("diet")}
            data-testid="pet-field-diet"
            {...form.register("diet")}
          />
          <Checkbox
            label={t("markUnknown", { field: t("fieldDiet") })}
            {...form.register("dietUnknown")}
          />
          <TextArea
            label={t("fieldCare")}
            description={t("optionalMax", { max: PET_LIMITS.long })}
            rows={3}
            error={error("careInstructions")}
            {...form.register("careInstructions")}
          />
          <TextArea
            label={t("sectionNotes")}
            description={t("optionalMax", { max: PET_LIMITS.long })}
            rows={3}
            error={error("notes")}
            data-testid="pet-field-notes"
            {...form.register("notes")}
          />
        </fieldset>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" loading={save.busy} data-testid="pet-profile-save">
            {t("save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
