import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";
import { getHomeDirectory } from "@/members/directory";
import { readPet, readPetCare, readPetMedical } from "@/pets/data";
import { petPath, petsPath } from "@/pets/format";

import { careMembers } from "./care-activity-page";
import { PetCareSection } from "./pet-care";
import { PetMedicalSection } from "./pet-medical";
import { PetProfileView } from "./pet-profile";

/** The document title: the pet's name when the viewer may see it. */
export async function petPageTitle(petId: string, fallback: string): Promise<string> {
  const id = z.uuid().safeParse(petId);
  const pet = id.success ? await readPet(id.data) : null;
  return pageTitle(pet?.status === "ok" ? pet.value.name : fallback);
}

/**
 * One pet's page (S31), read with the viewer's own session: its basic profile for every member, and
 * the Medical section only for someone with medical view at this moment. For anyone else nothing
 * medical is read or rendered, so the page looks the same whether the pet has medical records or
 * not (a medical read would answer not found anyway). The Care section is for every member.
 */
export async function PetPage({
  homeId,
  petId,
}: {
  readonly homeId: string;
  readonly petId: string;
}) {
  const id = z.uuid().safeParse(petId);
  if (!id.success) notFound();
  const [t, pet] = await Promise.all([getTranslations("Pets"), readPet(id.data)]);
  if (pet.status === "not-found") notFound();
  if (pet.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  if (pet.value.homeId !== homeId) redirect(petPath(pet.value.homeId, pet.value.id));
  const [medical, care, directory] = await Promise.all([
    pet.value.medicalAccess ? readPetMedical(pet.value.id) : null,
    readPetCare(pet.value.id),
    getHomeDirectory(pet.value.homeId),
  ]);
  return (
    <>
      <p className="mb-2">
        <Link href={petsPath(homeId)} className="text-body font-medium text-accent-fg underline">
          {t("backToPets")}
        </Link>
      </p>
      <div className="flex max-w-3xl flex-col gap-6">
        <PetProfileView pet={pet.value} />
        {medical?.status === "ok" ? (
          <PetMedicalSection pet={pet.value} medical={medical.value} />
        ) : medical && medical.status !== "not-found" ? (
          <ErrorState title={t("medicalLoadFailedTitle")} description={t("loadFailed")} />
        ) : null}
        {care.status === "ok" && directory.status === "ok" ? (
          <PetCareSection
            pet={pet.value}
            care={care.value}
            members={careMembers(directory.members)}
          />
        ) : (
          <ErrorState title={t("careLoadFailedTitle")} description={t("loadFailed")} />
        )}
      </div>
    </>
  );
}
