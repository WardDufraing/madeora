import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { ErrorState } from "@/components/ui/states";
import { readMedicalEntry, readPet } from "@/pets/data";
import { medicalEntryPath, petPath } from "@/pets/format";

import { MedicalEntryView } from "./medical-entry-view";

/**
 * One medical entry's page (S31), read with the viewer's own session. Without medical view it is
 * not found, exactly like an entry that does not exist (also for a forged id); one opened under
 * another pet's or Home's address is sent to its own.
 */
export async function MedicalEntryPage({
  homeId,
  petId,
  entryId,
}: {
  readonly homeId: string;
  readonly petId: string;
  readonly entryId: string;
}) {
  const id = z.uuid().safeParse(entryId);
  if (!id.success) notFound();
  const [t, entry] = await Promise.all([getTranslations("Pets"), readMedicalEntry(id.data)]);
  if (entry.status === "not-found") notFound();
  if (entry.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  if (entry.value.homeId !== homeId || entry.value.petId !== petId) {
    redirect(medicalEntryPath(entry.value.homeId, entry.value.petId, entry.value.id));
  }
  const pet = await readPet(entry.value.petId);
  return (
    <>
      <p className="mb-2">
        <Link
          href={petPath(homeId, petId)}
          className="text-body font-medium text-accent-fg underline"
        >
          {t("backToPet", { name: entry.value.petName })}
        </Link>
      </p>
      <MedicalEntryView
        entry={entry.value}
        birthDate={pet.status === "ok" ? pet.value.birthDate : null}
      />
    </>
  );
}
