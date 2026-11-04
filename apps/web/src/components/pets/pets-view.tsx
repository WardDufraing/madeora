"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/states";
import { TextField } from "@/components/ui/text-field";
import { PETS_ENDPOINT, sendPetRequest, type PetList } from "@/pets/api";
import { petPath } from "@/pets/format";
import { createPetSchema, PET_LIMITS } from "@/pets/schema";

import { PetFailureAlert, PetPhoto } from "./pet-parts";
import { usePetMutation } from "./use-pet-mutation";
import { usePetTexts } from "./use-pet-texts";

export interface PetsViewProps {
  readonly homeId: string;
  readonly list: PetList;
  /** The Home's today. */
  readonly today: string;
}

/**
 * The pets of a Home (S31): a card per pet with its photo, name, species and age, for every member.
 * Pet managers add a pet with only its name and fill in the rest on its profile. Nothing here hints
 * at medical information.
 */
export function PetsView({ homeId, list, today }: PetsViewProps) {
  const t = useTranslations("Pets");
  const texts = usePetTexts();
  const [adding, setAdding] = useState(false);
  const full = list.pets.length >= list.limit;
  return (
    <div className="flex flex-col gap-6" data-testid="pets-view">
      {list.access === "manage" ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => {
              setAdding(true);
            }}
            disabled={full}
            data-testid="pet-new"
          >
            {t("addPet")}
          </Button>
          {full ? (
            <p className="text-helper text-fg-muted">{t("limitReached", { max: list.limit })}</p>
          ) : null}
        </div>
      ) : null}
      {list.pets.length === 0 ? (
        <EmptyState
          title={t("emptyTitle")}
          description={list.access === "manage" ? t("emptyManage") : t("emptyView")}
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.pets.map((pet) => {
            const age = texts.age(pet, today);
            return (
              <li key={pet.id}>
                <Link
                  href={petPath(homeId, pet.id)}
                  className="flex items-center gap-3 rounded-card border border-line bg-surface p-3 text-fg hover:border-line-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  data-testid="pet-card"
                >
                  <PetPhoto fileId={pet.photoFileId} name={pet.name} size="card" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-body font-semibold">
                      <bdi>{pet.name}</bdi>
                    </span>
                    {pet.species ? (
                      <span className="text-helper text-fg-muted">
                        <bdi>{texts.species(pet.species, pet.speciesLabel)}</bdi>
                      </span>
                    ) : null}
                    {age ? <span className="text-helper text-fg-muted">{age}</span> : null}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {adding ? (
        <AddPetDialog
          homeId={homeId}
          onClose={() => {
            setAdding(false);
          }}
        />
      ) : null}
    </div>
  );
}

/** Adds a pet with only its name, then opens its profile. */
function AddPetDialog({
  homeId,
  onClose,
}: {
  readonly homeId: string;
  readonly onClose: () => void;
}) {
  const t = useTranslations("Pets");
  const texts = usePetTexts();
  const router = useRouter();
  const [id] = useState(() => crypto.randomUUID());
  const form = useForm<{ name: string }>({ defaultValues: { name: "" } });
  const save = usePetMutation(
    `pet:${id}`,
    (body: object) => sendPetRequest("POST", PETS_ENDPOINT, body),
    () => {
      onClose();
      router.push(petPath(homeId, id));
    },
  );
  const error = form.formState.errors.name;
  return (
    <Dialog open onClose={onClose} title={t("addPetTitle")} closeLabel={t("close")}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void form.handleSubmit((values) => {
            const parsed = createPetSchema.safeParse({ id, homeId, name: values.name });
            if (!parsed.success) {
              const issue = parsed.error.issues.find((item) => item.path[0] === "name");
              form.setError("name", { message: issue?.message ?? "invalid" });
              form.setFocus("name");
              return;
            }
            save.mutate(parsed.data);
          })(event);
        }}
        data-testid="pet-new-form"
      >
        <PetFailureAlert error={save.error} />
        <TextField
          label={t("fieldName")}
          description={t("fieldNameHint", { max: PET_LIMITS.name })}
          autoComplete="off"
          required
          error={error ? texts.field(error.message) : undefined}
          data-testid="pet-name"
          {...form.register("name")}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" loading={save.busy} data-testid="pet-new-save">
            {t("addPetSave")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
