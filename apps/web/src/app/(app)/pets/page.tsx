import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { RememberContext } from "@/components/homes/remember-context";
import { PageHeader } from "@/components/shell/page-header";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { listMyHomes } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { petsPath } from "@/pets/format";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Pets");
  return { title: await pageTitle(t("title")) };
}

/**
 * Pets in the Personal context (S31). Pets belong to Homes (there are no Personal pets), so
 * this page lists the person's Homes with a link to each one's pets.
 */
export default async function PersonalPetsPage() {
  const { userId } = await requireIdentity();
  const [t, homes] = await Promise.all([getTranslations("Pets"), listMyHomes()]);
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
                  href={petsPath(home.id)}
                  className="text-body font-semibold text-accent-fg underline"
                  data-testid="personal-pets-home"
                >
                  {t("homePetsLink", { home: home.name })}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
