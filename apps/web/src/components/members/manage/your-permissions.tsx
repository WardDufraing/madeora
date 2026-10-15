import { delegableCapabilities, type HomeMembershipFacts } from "@madeora/domain/permissions";
import { useTranslations } from "next-intl";

import { Card } from "@/components/ui/card";

import { useCapabilityLabels } from "./use-capability-labels";

/**
 * The person's own role in this Home and, for an Administrator, the rights the Owner granted them
 * (S12; spec: an Administrator can see their effective permissions). Read-only and informational:
 * every action is decided by the server. Grants are read fresh on each request.
 */
export function YourPermissions({
  membership,
  className,
}: {
  readonly membership: HomeMembershipFacts;
  readonly className?: string;
}) {
  const t = useTranslations("Manage");
  const labels = useCapabilityLabels();
  const granted = delegableCapabilities.filter((capability) =>
    membership.grantedCapabilities.has(capability),
  );

  return (
    <Card title={t("yourPermissionsTitle")} {...(className ? { className } : {})}>
      <div className="flex flex-col gap-3 text-body text-fg" data-testid="your-permissions">
        {membership.role === "owner" ? <p>{t("yourPermissionsOwner")}</p> : null}
        {membership.role === "member" ? <p>{t("yourPermissionsMember")}</p> : null}
        {membership.role === "administrator" && granted.length === 0 ? (
          <p>{t("yourPermissionsAdministratorNone")}</p>
        ) : null}
        {membership.role === "administrator" && granted.length > 0 ? (
          <>
            <p>{t("yourPermissionsAdministrator")}</p>
            <ul className="flex flex-col gap-2">
              {granted.map((capability) => (
                <li key={capability} className="flex flex-col">
                  <span className="font-medium">{labels.name(capability)}</span>
                  <span className="text-helper text-fg-muted">
                    {labels.description(capability)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </Card>
  );
}
