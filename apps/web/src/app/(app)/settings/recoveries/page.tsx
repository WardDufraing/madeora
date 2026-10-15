import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { FormAlert } from "@/components/auth/form-alert";
import { RecoveryAppealForm } from "@/components/recovery/recovery-appeal-form";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { getRecoveredHomes } from "@/recovery/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Recovery");
  return { title: await pageTitle(t("recoveredTitle")) };
}

interface RecoveredPageProps {
  readonly searchParams: Promise<{ readonly appealed?: string | string[] }>;
}

/**
 * For a former Owner: the Homes taken over from them through a verified recovery, and the protected
 * appeal path (S12b; spec: "a protected appeal path without automatic reversal"). Reachable even
 * when they were removed from the Home, because it reads their own account, not a membership.
 */
export default async function RecoveredHomesPage({ searchParams }: RecoveredPageProps) {
  await requireIdentity();
  const [t, tNav, recovered, formats, query] = await Promise.all([
    getTranslations("Recovery"),
    getTranslations("Nav"),
    getRecoveredHomes(),
    getDateTimeFormats(),
    searchParams,
  ]);

  return (
    <>
      <PageHeader title={t("recoveredTitle")} />
      <p className="mb-6 text-body text-fg-muted">
        <Link href="/settings" className="font-medium text-accent-fg underline">
          {tNav("settings")}
        </Link>
      </p>
      <div className="flex max-w-2xl flex-col gap-6">
        {query.appealed === "1" ? (
          <FormAlert tone="success">{t("appealedNotice")}</FormAlert>
        ) : null}
        {recovered.status === "unavailable" ? (
          <FormAlert tone="error">{t("loadFailed")}</FormAlert>
        ) : recovered.homes.length === 0 ? (
          <EmptyState title={t("recoveredEmptyTitle")} description={t("recoveredEmpty")} />
        ) : (
          recovered.homes.map((home) => (
            <Card key={home.recoveryId} title={home.homeName}>
              <div className="flex flex-col gap-4" data-testid="recovered-home">
                <p className="text-body text-fg">
                  {t("recoveredText", {
                    date: formatDateTime(home.completedAt, formats),
                  })}{" "}
                  {home.stillMember ? t("recoveredStillMember") : t("recoveredRemoved")}
                </p>
                {home.appealStatus === "open" ? (
                  <p className="text-body text-fg">{t("appealOpen")}</p>
                ) : (
                  <>
                    {home.appealStatus === "closed" ? (
                      <p className="text-body text-fg">{t("appealClosed")}</p>
                    ) : null}
                    <RecoveryAppealForm recoveryId={home.recoveryId} homeName={home.homeName} />
                  </>
                )}
              </div>
            </Card>
          ))
        )}
      </div>
    </>
  );
}
