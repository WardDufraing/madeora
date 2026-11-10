import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { listMyClosedHomes } from "@/activity/server";
import { parseAccountChangeAction } from "@/auth/google-reauth";
import { getVerifiedUser, requireIdentity } from "@/auth/identity";
import { getAccountSecurity } from "@/auth/security-server";
import { verifiedTotpFactor } from "@/auth/two-factor";
import { FormAlert } from "@/components/auth/form-alert";
import { RestoreHome } from "@/components/deletion/restore-home";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { pageTitle } from "@/i18n/page-title";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Deletion");
  return { title: await pageTitle(t("closedTitle")) };
}

interface ClosedHomesPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Settings › Closed Homes (S40): the Homes the person closed as their Owner, each with the date it
 * will be deleted for good and Restore. Nobody else sees these Homes, or this list.
 */
export default async function ClosedHomesPage({ searchParams }: ClosedHomesPageProps) {
  await requireIdentity();
  const [t, params, user, security, closed, formats] = await Promise.all([
    getTranslations("Deletion"),
    searchParams,
    getVerifiedUser(),
    getAccountSecurity(),
    listMyClosedHomes(),
    getDateTimeFormats(),
  ]);
  if (!user) return null;
  const hasPassword = security.status === "ok" ? security.value.hasPassword : true;
  const confirmed = parseAccountChangeAction(params.confirmed);

  return (
    <>
      <PageHeader title={t("closedTitle")} />
      <div className="flex max-w-2xl flex-col gap-6">
        {params.status === "closed" ? (
          <FormAlert tone="success" announce>
            {t("closedNotice")}
          </FormAlert>
        ) : null}
        <p className="text-body text-fg-muted">{t("closedIntro")}</p>
        {closed.status === "unavailable" ? (
          <FormAlert tone="error">{t("unavailable")}</FormAlert>
        ) : closed.value.length === 0 ? (
          <p className="text-body" data-testid="closed-homes-empty">
            {t("closedEmpty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-4" aria-label={t("closedTitle")}>
            {closed.value.map((home) => (
              <li key={home.homeId} data-testid="closed-home">
                <Card title={home.homeName}>
                  <p className="mb-4 text-body">
                    {t("closedUntil", { date: formatDateTime(home.purgeAfter, formats) })}
                  </p>
                  <RestoreHome
                    homeId={home.homeId}
                    email={user.email ?? ""}
                    userId={user.id}
                    twoFactor={verifiedTotpFactor(user) !== null}
                    hasPassword={hasPassword}
                    confirmed={closed.value.length === 1 ? confirmed : null}
                  />
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
