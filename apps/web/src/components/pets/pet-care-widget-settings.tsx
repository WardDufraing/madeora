"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { FormAlert } from "@/components/auth/form-alert";
import { SelectField } from "@/components/ui/select-field";
import {
  petCareWidgetCounts,
  petCareWidgetDays,
  petCareWidgetWho,
  type WidgetConfigs,
} from "@/dashboard/widgets";
import { PETS_ENDPOINT, type PetList } from "@/pets/api";
import { petKeys } from "@/pets/format";

type Config = WidgetConfigs["pet-care"];

async function readPetOptions(homeId: string): Promise<PetList> {
  const response = await fetch(`${PETS_ENDPOINT}?${new URLSearchParams({ homeId }).toString()}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("pets read failed");
  const payload = (await response.json()) as { readonly list: PetList };
  return payload.list;
}

/**
 * The Pet care widget's settings (S31 care part): which pet (or all), the period, whose care and how
 * many items. A chosen pet that is gone stays shown as unavailable until another is chosen; the
 * server reads the care again on every render.
 */
export function PetCareWidgetSettings({
  config,
  homeId,
  onChange,
}: {
  readonly config: Config;
  readonly homeId: string | null;
  readonly onChange: (config: Config) => void;
}) {
  const t = useTranslations("Dashboard");
  const pets = useQuery({
    queryKey: [...petKeys.all, "options", homeId],
    queryFn: () => readPetOptions(homeId ?? ""),
    enabled: homeId !== null,
    retry: false,
  });
  const set = <K extends keyof Config>(key: K, value: Config[K]) => {
    onChange({ ...config, [key]: value });
  };
  const list = pets.data?.pets ?? [];
  const known = config.petId === null || list.some((pet) => pet.id === config.petId);
  return (
    <div className="flex flex-col gap-4">
      {pets.error ? (
        <FormAlert tone="error" announce>
          {t("settingPetCareFailed")}
        </FormAlert>
      ) : (
        <SelectField
          label={t("settingPetCarePet")}
          value={config.petId ?? ""}
          disabled={pets.isPending}
          options={[
            { value: "", label: t("settingPetCareAllPets") },
            ...(known || pets.isPending
              ? []
              : [{ value: config.petId ?? "", label: t("settingPetCarePetUnavailable") }]),
            ...list.map((pet) => ({ value: pet.id, label: pet.name })),
          ]}
          onChange={(event) => {
            const value = event.currentTarget.value;
            set("petId", value === "" ? null : value);
          }}
          data-testid="pet-care-widget-pet"
        />
      )}
      <SelectField
        label={t("settingPetCareDays")}
        value={String(config.days)}
        options={petCareWidgetDays.map((days) => ({
          value: String(days),
          label: t("settingPetCareDaysOption", { days }),
        }))}
        onChange={(event) => {
          const value = Number(event.currentTarget.value);
          set("days", petCareWidgetDays.find((days) => days === value) ?? 1);
        }}
      />
      <SelectField
        label={t("settingPetCareWho")}
        value={config.who}
        options={petCareWidgetWho.map((who) => ({
          value: who,
          label:
            who === "all"
              ? t("settingPetCareWhoAll")
              : who === "me"
                ? t("settingPetCareWhoMe")
                : t("settingPetCareWhoUnassigned"),
        }))}
        onChange={(event) => {
          const value = event.currentTarget.value;
          set("who", petCareWidgetWho.find((who) => who === value) ?? "all");
        }}
      />
      <SelectField
        label={t("settingPetCareCount")}
        value={String(config.count)}
        options={petCareWidgetCounts.map((count) => ({
          value: String(count),
          label: t("settingCountOption", { count }),
        }))}
        onChange={(event) => {
          const value = Number(event.currentTarget.value);
          set("count", petCareWidgetCounts.find((count) => count === value) ?? 5);
        }}
      />
    </div>
  );
}
