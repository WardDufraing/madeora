import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { zonedParts } from "@/chores/format";
import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { readPets } from "@/pets/data";

import { PetsView } from "./pets-view";

/**
 * The pets page of a Home (S31), read with the viewer's own session: a Home they are not in is not
 * found.
 */
export async function PetsPage({
  home,
}: {
  readonly home: { readonly id: string; readonly name: string; readonly timeZone: string };
}) {
  const [t, list] = await Promise.all([getTranslations("Pets"), readPets(home.id)]);
  if (list.status === "not-found") notFound();
  if (list.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const today = zonedParts(new Date().toISOString(), home.timeZone).date;
  return (
    <>
      <PageHeader title={t("homeTitle", { home: home.name })} />
      <PetsView homeId={home.id} list={list.value} today={today} />
    </>
  );
}
