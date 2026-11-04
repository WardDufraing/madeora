import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { CalendarView } from "@/components/calendar/calendar-view";
import { RememberContext } from "@/components/homes/remember-context";
import { pageTitle } from "@/i18n/page-title";

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Calendar");
  return { title: await pageTitle(t("pageTitle")) };
}

/** The Personal calendar (S32): the person's own events only, visible to them alone. */
export default async function Page({ searchParams }: PageProps) {
  const { userId } = await requireIdentity();
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "personal" }} />
      <CalendarView home={null} searchParams={await searchParams} />
    </>
  );
}
