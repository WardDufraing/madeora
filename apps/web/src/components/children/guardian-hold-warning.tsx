import { useTranslations } from "next-intl";

import type { GuardianHoldWarning as Warning } from "@/activity/server";
import { FormAlert } from "@/components/auth/form-alert";
import { isolate } from "@/invitations/format";

/**
 * S41-M3: before someone leaves a Home, deactivates or deletes their account, the children whose
 * only eligible primary guardian they are, per Home: those children are put on hold (they cannot
 * sign in there) until a primary guardian is appointed, or until a deactivated guardian returns.
 */
export function GuardianHoldWarning({
  warnings,
  context,
}: {
  readonly warnings: readonly Warning[];
  readonly context: "leave" | "account";
}) {
  const t = useTranslations("Children");
  if (warnings.length === 0) return null;
  return (
    <div data-testid="guardian-hold-warning">
      <FormAlert tone="info">
        <p>
          {context === "leave"
            ? t("holdWarningLeave", { count: warnings[0]?.children ?? 0 })
            : t("holdWarningAccount")}
        </p>
        {context === "account" ? (
          <ul className="mt-2 flex list-disc flex-col gap-1 ps-5">
            {warnings.map((warning) => (
              <li key={warning.homeId}>
                {t("holdWarningHome", { count: warning.children, home: isolate(warning.homeName) })}
              </li>
            ))}
          </ul>
        ) : null}
      </FormAlert>
    </div>
  );
}
