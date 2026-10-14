import type { HomeRole } from "@madeora/domain/permissions";
import { useTranslations } from "next-intl";

/** The translated name of a Home role. Works in server and client components. */
export function useRoleLabel(): (role: HomeRole) => string {
  const t = useTranslations("Homes");
  const labels: { readonly [R in HomeRole]: string } = {
    owner: t("roleOwner"),
    administrator: t("roleAdministrator"),
    member: t("roleMember"),
  };
  return (role) => labels[role];
}
