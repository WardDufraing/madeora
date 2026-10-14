import type { HomeRole } from "@madeora/domain/permissions";
import { useTranslations } from "next-intl";

import { useRoleLabel } from "@/components/shell/use-role-label";

/** "Your role here: Owner", for a Home page. */
export function RoleLabel({ role }: { readonly role: HomeRole }) {
  const t = useTranslations("Homes");
  const roleLabel = useRoleLabel();
  return <>{t("yourRole", { role: roleLabel(role) })}</>;
}
