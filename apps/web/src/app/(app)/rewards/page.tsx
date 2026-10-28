import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { RememberContext } from "@/components/homes/remember-context";
import { PersonalRewardsPage } from "@/components/personal-points/personal-rewards-page";
import { pageTitle } from "@/i18n/page-title";

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("PersonalPoints");
  return { title: await pageTitle(t("rewardsTitle")) };
}

/** Personal rewards (S28b): the signed-in person's own, self-defined rewards and redemptions. */
export default async function PersonalRewardsRoute({ searchParams }: PageProps) {
  const { userId } = await requireIdentity();
  const archived = (await searchParams).archived === "true";
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "personal" }} />
      <PersonalRewardsPage archived={archived} />
    </>
  );
}
