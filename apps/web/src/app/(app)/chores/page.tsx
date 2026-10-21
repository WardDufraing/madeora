import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { RememberContext } from "@/components/homes/remember-context";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { choresPath } from "@/chores/format";
import { listMyHomes } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Chores");
  return { title: await pageTitle(t("title")) };
}

/**
 * Chores in the Personal context (S20). Chores belong to Homes (there are no Personal chores), so
 * this page lists the person's Homes with a link to each one's chores.
 */
export default async function PersonalChoresPage() {
  const { userId } = await requireIdentity();
  const [t, homes] = await Promise.all([getTranslations("Chores"), listMyHomes()]);
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "personal" }} />
      <PageHeader title={t("title")} />
      {homes.status !== "ok" ? (
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      ) : homes.homes.length === 0 ? (
        <EmptyState title={t("personalNoHomesTitle")} description={t("personalNoHomes")} />
      ) : (
        <div className="flex max-w-3xl flex-col gap-3">
          <p className="text-body text-fg-muted">{t("personalIntro")}</p>
          <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
            {homes.homes.map((home) => (
              <li key={home.id} className="p-3">
                <Link
                  href={choresPath(home.id)}
                  className="text-body font-semibold text-accent-fg underline"
                  data-testid="personal-chores-home"
                >
                  {t("homeChoresLink", { home: home.name })}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
