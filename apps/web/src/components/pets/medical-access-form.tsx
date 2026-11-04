"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { medicalAccessEndpoint, sendPetRequest } from "@/pets/api";
import { medicalAccessSchema } from "@/pets/schema";

import { PetFailureAlert } from "./pet-parts";
import { usePetMutation } from "./use-pet-mutation";

const levels = ["none", "view", "manage"] as const;
type Level = (typeof levels)[number];

/**
 * Sets one member's access to pet medical information in this Home (S31): No access, View, or View
 * and edit. It works on the member's next request and is audited; the database decides again who
 * may change it.
 */
export function MedicalAccessForm({
  homeId,
  membershipId,
  memberName,
  level,
}: {
  readonly homeId: string;
  readonly membershipId: string;
  readonly memberName: string;
  readonly level: Level;
}) {
  const t = useTranslations("Pets");
  const [chosen, setChosen] = useState<Level>(level);
  const [saved, setSaved] = useState(false);
  const [synced, setSynced] = useState(level);
  if (synced !== level) {
    setSynced(level);
    setChosen(level);
  }
  const save = usePetMutation(
    `pet-access:${membershipId}`,
    (body: object) => sendPetRequest("PUT", medicalAccessEndpoint(homeId), body),
    () => {
      setSaved(true);
    },
  );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(false);
        const parsed = medicalAccessSchema.safeParse({ membershipId, level: chosen });
        if (parsed.success) save.mutate(parsed.data);
      }}
      data-testid="pet-access-form"
    >
      {saved ? (
        <FormAlert tone="success" announce>
          {t("accessSaved", { name: memberName })}
        </FormAlert>
      ) : null}
      <PetFailureAlert error={save.error} />
      <SelectField
        label={t("accessLabel", { name: memberName })}
        options={[
          { value: "none", label: t("accessNone") },
          { value: "view", label: t("accessView") },
          { value: "manage", label: t("accessManage") },
        ]}
        value={chosen}
        onChange={(event) => {
          setSaved(false);
          setChosen(levels.find((value) => value === event.target.value) ?? "none");
        }}
        data-testid="pet-access-level"
      />
      <div>
        <Button
          type="submit"
          disabled={chosen === level}
          loading={save.busy}
          data-testid="pet-access-save"
        >
          {t("accessSave")}
        </Button>
      </div>
    </form>
  );
}
