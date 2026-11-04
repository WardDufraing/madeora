import { getTranslations } from "next-intl/server";

import { ErrorState } from "@/components/ui/states";
import type { WidgetConfigs } from "@/dashboard/widgets";
import { getHomeDirectory } from "@/members/directory";
import { readHomeCare } from "@/pets/data";

import { careMembers } from "./care-activity-page";
import { PetCareWidgetBody } from "./pet-care-widget-body";

/**
 * The Pet care widget (S31 care part): a Home's open pet care, read with the viewer's own session
 * (concealed where they lack medical view, exactly as on the pet's page). A Home the viewer has left
 * shows nothing of it.
 */
export async function PetCareWidget({
  homeId,
  config,
}: {
  readonly homeId: string;
  readonly config: WidgetConfigs["pet-care"];
}) {
  const [t, care, directory] = await Promise.all([
    getTranslations("Pets"),
    readHomeCare(homeId, config),
    getHomeDirectory(homeId),
  ]);
  if (care.status !== "ok" || directory.status !== "ok") {
    return <ErrorState title={t("widgetFailedTitle")} description={t("widgetFailed")} />;
  }
  return (
    <PetCareWidgetBody
      homeId={homeId}
      care={care.value}
      members={careMembers(directory.members)}
      days={config.days}
    />
  );
}
