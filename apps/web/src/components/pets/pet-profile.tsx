"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { petEndpoint, sendPetRequest, type PetDetail } from "@/pets/api";
import { petsPath } from "@/pets/format";
import { petPhotoTypes, type PetUnknownField } from "@/pets/schema";
import {
  newPetAttempt,
  PetUploadError,
  uploadPetPhoto,
  type PetUploadAttempt,
  type PetUploadFailure,
} from "@/pets/upload";

import { ConfirmDialog, NotEntered, PetPhoto, PetValue } from "./pet-parts";
import { PetProfileForm } from "./pet-profile-form";
import { usePetMutation } from "./use-pet-mutation";
import { usePetTexts } from "./use-pet-texts";

export const unitKey = { kg: "unitKg", g: "unitG", lb: "unitLb" } as const;

/**
 * A pet's basic profile (S31), visible to every member: identity, weight, veterinarian, diet and
 * care, and notes. Each field shows its value, Unknown, or Not entered (never None). Pet managers
 * edit it, change or remove the photo and move the pet to the trash.
 */
export function PetProfileView({ pet }: { readonly pet: PetDetail }) {
  const t = useTranslations("Pets");
  const texts = usePetTexts();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const manage = pet.access === "manage";
  const unknown = (field: PetUnknownField) => pet.unknown.includes(field);
  const show = (field: PetUnknownField | null, value: ReactNode | null) =>
    value !== null ? value : field && unknown(field) ? t("unknown") : <NotEntered />;

  const remove = usePetMutation(
    `pet:${pet.id}`,
    () => sendPetRequest("DELETE", petEndpoint(pet.id), { revision: pet.revision }),
    () => {
      router.push(petsPath(pet.homeId));
    },
  );

  const age = texts.age(pet, pet.today);
  const birth = pet.birthDate
    ? t("bornOn", { date: texts.date(pet.birthDate), age: age ?? "" })
    : pet.ageYears !== null || pet.ageMonths !== null
      ? pet.ageRecordedOn
        ? t("ageAsOf", {
            age: t("ageValue", { years: pet.ageYears ?? 0, months: pet.ageMonths ?? 0 }),
            date: texts.date(pet.ageRecordedOn),
          })
        : t("ageAbout", {
            age: t("ageValue", { years: pet.ageYears ?? 0, months: pet.ageMonths ?? 0 }),
          })
      : null;
  const weight =
    pet.weight !== null && pet.weightUnit
      ? [
          `${new Intl.NumberFormat(texts.locale, { maximumFractionDigits: 3 }).format(pet.weight)} ${t(unitKey[pet.weightUnit])}`,
          pet.weightRecordedOn ? t("recordedOn", { date: texts.date(pet.weightRecordedOn) }) : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;
  const sex = pet.sex ? t(pet.sex === "female" ? "sexFemale" : "sexMale") : null;
  const neutered = pet.neutered === null ? null : pet.neutered ? t("yes") : t("no");

  return (
    <>
      <Card>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <PetPhoto fileId={pet.photoFileId} name={pet.name} size="profile" />
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="text-page-title font-semibold text-fg" data-testid="pet-title">
              <bdi>{pet.name}</bdi>
            </h1>
            {pet.species ? (
              <p className="text-body text-fg-muted">
                <bdi>{texts.species(pet.species, pet.speciesLabel)}</bdi>
                {age ? ` · ${age}` : null}
              </p>
            ) : null}
            {manage ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    setEditing(true);
                  }}
                  data-testid="pet-edit"
                >
                  {t("editProfile")}
                </Button>
                <PhotoControls pet={pet} />
                <Button
                  variant="ghost"
                  onClick={() => {
                    remove.reset();
                    setDeleting(true);
                  }}
                  data-testid="pet-delete"
                >
                  {t("deletePet")}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </Card>

      <Card title={t("sectionIdentity")}>
        <dl className="flex flex-col gap-3" data-testid="pet-identity">
          <PetValue label={t("fieldSpecies")}>
            {show("species", pet.species ? texts.species(pet.species, pet.speciesLabel) : null)}
          </PetValue>
          <PetValue label={t("fieldBreed")} testId="pet-breed">
            {show("breed", pet.breed)}
          </PetValue>
          <PetValue label={t("fieldBirth")}>{show("birth", birth)}</PetValue>
          <PetValue label={t("fieldSex")}>{show("sex", sex)}</PetValue>
          <PetValue label={t("fieldNeutered")}>{show("neutered", neutered)}</PetValue>
        </dl>
      </Card>

      <Card title={t("sectionHealthBasics")}>
        <dl className="flex flex-col gap-3">
          <PetValue label={t("fieldWeight")}>{show("weight", weight)}</PetValue>
        </dl>
      </Card>

      <Card title={t("sectionVet")}>
        <dl className="flex flex-col gap-3">
          <PetValue label={t("fieldVetName")}>{show(null, pet.vetName)}</PetValue>
          <PetValue label={t("fieldVetClinic")}>{show(null, pet.vetClinic)}</PetValue>
          <PetValue label={t("fieldVetPhone")}>
            {pet.vetPhone ? (
              <a href={`tel:${pet.vetPhone}`} className="text-accent-fg underline">
                {pet.vetPhone}
              </a>
            ) : (
              <NotEntered />
            )}
          </PetValue>
          <PetValue label={t("fieldVetEmail")}>
            {pet.vetEmail ? (
              <a href={`mailto:${pet.vetEmail}`} className="text-accent-fg underline">
                {pet.vetEmail}
              </a>
            ) : (
              <NotEntered />
            )}
          </PetValue>
          <PetValue label={t("fieldVetAddress")}>{show(null, pet.vetAddress)}</PetValue>
        </dl>
      </Card>

      <Card title={t("sectionCare")}>
        <dl className="flex flex-col gap-3">
          <PetValue label={t("fieldDiet")}>{show("diet", pet.diet)}</PetValue>
          <PetValue label={t("fieldCare")}>{show(null, pet.careInstructions)}</PetValue>
        </dl>
      </Card>

      <Card title={t("sectionNotes")}>
        <p className="whitespace-pre-line break-words text-body text-fg">
          {pet.notes ?? <NotEntered />}
        </p>
      </Card>

      {editing ? (
        <PetProfileForm
          pet={pet}
          onClose={() => {
            setEditing(false);
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title={t("deletePetTitle", { name: pet.name })}
          description={t("deletePetExplanation")}
          confirmLabel={t("deletePetConfirm")}
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
    </>
  );
}

/** Choose a new photo (uploaded, checked and applied at once), or remove the current one. */
function PhotoControls({ pet }: { readonly pet: PetDetail }) {
  const t = useTranslations("Pets");
  const texts = usePetTexts();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const attempt = useRef<{ file: File; attempt: PetUploadAttempt } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [failure, setFailure] = useState<PetUploadFailure | null>(null);
  /** The file of a failed upload that a retry sends again (same attempt, same upload). */
  const [retryable, setRetryable] = useState<File | null>(null);
  const removePhoto = usePetMutation(`pet:${pet.id}`, () =>
    sendPetRequest("DELETE", petEndpoint(pet.id, "photo"), { revision: pet.revision }),
  );

  const upload = async (file: File) => {
    if (attempt.current?.file !== file) attempt.current = { file, attempt: newPetAttempt() };
    setUploading(true);
    setFailure(null);
    try {
      await uploadPetPhoto(pet.id, file, attempt.current.attempt);
      attempt.current = null;
      setRetryable(null);
      router.refresh();
    } catch (error) {
      const reason = error instanceof PetUploadError ? error.failure : "failed";
      setFailure(reason);
      setRetryable(reason === "type" || reason === "size" || reason === "limit" ? null : file);
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        accept={petPhotoTypes.join(",")}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
        data-testid="pet-photo-input"
      />
      <Button
        variant="secondary"
        loading={uploading}
        onClick={() => {
          input.current?.click();
        }}
        data-testid="pet-photo-choose"
      >
        {pet.photoFileId ? t("changePhoto") : t("addPhoto")}
      </Button>
      {pet.photoFileId ? (
        <Button
          variant="ghost"
          loading={removePhoto.busy}
          onClick={() => {
            removePhoto.mutate(undefined);
          }}
          data-testid="pet-photo-remove"
        >
          {t("removePhoto")}
        </Button>
      ) : null}
      {failure ? (
        <FormAlert tone="error" announce className="w-full">
          {texts.upload(failure)}
          {retryable ? (
            <>
              {" "}
              <button
                type="button"
                className="font-medium text-accent-fg underline"
                onClick={() => {
                  void upload(retryable);
                }}
              >
                {t("retry")}
              </button>
            </>
          ) : null}
        </FormAlert>
      ) : null}
      {removePhoto.error ? (
        <FormAlert tone="error" announce className="w-full">
          {texts.failure(removePhoto.error.failure)}
        </FormAlert>
      ) : null}
    </>
  );
}
