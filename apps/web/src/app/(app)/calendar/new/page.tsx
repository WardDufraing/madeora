import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { NewEventPage } from "@/components/calendar/event-pages";
import { RememberContext } from "@/components/homes/remember-context";
import { pageTitle } from "@/i18n/page-title";

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Calendar");
  return { title: await pageTitle(t("newEventTitle")) };
}

/** A new personal event (S32). */
export default async function Page({ searchParams }: PageProps) {
  const { userId } = await requireIdentity();
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "personal" }} />
      <NewEventPage home={null} searchParams={await searchParams} />
    </>
  );
}
