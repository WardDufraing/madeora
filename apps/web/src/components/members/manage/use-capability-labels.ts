import type { DelegableCapability } from "@madeora/domain/permissions";
import { useTranslations } from "next-intl";

/**
 * Each Administrator capability's name and what it allows, translated. Works in server and client
 * components. A new capability fails the type check here until it has readable text (spec:
 * "readable descriptions of what each permission permits and its consequences").
 */
export function useCapabilityLabels(): {
  readonly name: (capability: DelegableCapability) => string;
  readonly description: (capability: DelegableCapability) => string;
} {
  const t = useTranslations("Manage");
  const names: { readonly [C in DelegableCapability]: string } = {
    manageHomeSettings: t("capManageHomeSettings"),
    manageInvitations: t("capManageInvitations"),
    removeMembers: t("capRemoveMembers"),
    manageHomeDashboard: t("capManageHomeDashboard"),
    manageHomeTasks: t("capManageHomeTasks"),
  };
  const descriptions: { readonly [C in DelegableCapability]: string } = {
    manageHomeSettings: t("capManageHomeSettingsDescription"),
    manageInvitations: t("capManageInvitationsDescription"),
    removeMembers: t("capRemoveMembersDescription"),
    manageHomeDashboard: t("capManageHomeDashboardDescription"),
    manageHomeTasks: t("capManageHomeTasksDescription"),
  };
  return { name: (c) => names[c], description: (c) => descriptions[c] };
}
