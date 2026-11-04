import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { ErrorState } from "@/components/ui/states";
import { getHomeDirectory } from "@/members/directory";
import { readCareActivity, readPet } from "@/pets/data";
import { careActivityPath, petPath } from "@/pets/format";

import { CareActivityView } from "./care-activity-view";
import type { CareMember } from "./care-parts";

/**
 * One care activity's page (S31 care part), read with the viewer's own session. Every member of the
 * Home sees it; one opened under another pet's or Home's address is sent to its own, and a forged
 * id is not found.
 */
export async function CareActivityPage({
  homeId,
  petId,
  activityId,
}: {
  readonly homeId: string;
  readonly petId: string;
  readonly activityId: string;
}) {
  const id = z.uuid().safeParse(activityId);
  if (!id.success) notFound();
  const [t, activity] = await Promise.all([getTranslations("Pets"), readCareActivity(id.data)]);
  if (activity.status === "not-found") notFound();
  if (activity.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const value = activity.value;
  if (value.homeId !== homeId || value.petId !== petId) {
    redirect(careActivityPath(value.homeId, value.petId, value.id));
  }
  const [pet, directory] = await Promise.all([
    readPet(value.petId),
    getHomeDirectory(value.homeId),
  ]);
  if (pet.status !== "ok" || directory.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  return (
    <>
      <p className="mb-2">
        <Link
          href={petPath(homeId, petId)}
          className="text-body font-medium text-accent-fg underline"
        >
          {t("backToPet", { name: pet.value.name })}
        </Link>
      </p>
      <CareActivityView
        activity={value}
        petName={pet.value.name}
        members={careMembers(directory.members)}
        canMarkMedical={pet.value.medicalAccess === "manage"}
      />
    </>
  );
}

/** The Home's members as the care views name them. */
export function careMembers(
  members: readonly {
    readonly membershipId: string;
    readonly name: string | null;
    readonly isSelf: boolean;
  }[],
): CareMember[] {
  return members.map((member) => ({
    id: member.membershipId,
    name: member.name,
    isSelf: member.isSelf,
  }));
}
