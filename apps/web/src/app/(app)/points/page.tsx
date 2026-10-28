import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { requireIdentity } from "@/auth/identity";
import { RememberContext } from "@/components/homes/remember-context";
import { PersonalPointsPage } from "@/components/personal-points/personal-points-page";
import { pageTitle } from "@/i18n/page-title";

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("PersonalPoints");
  return { title: await pageTitle(t("pointsTitle")) };
}

/** Personal points (S28b): the signed-in person's own ledger, with or without any Home. */
export default async function PersonalPointsRoute({ searchParams }: PageProps) {
  const { userId } = await requireIdentity();
  const before = z.coerce
    .number()
    .int()
    .min(1)
    .safeParse((await searchParams).before);
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "personal" }} />
      <PersonalPointsPage before={before.success ? before.data : null} />
    </>
  );
}
