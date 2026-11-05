import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { EditEventPage } from "@/components/calendar/event-pages";
import { RememberContext } from "@/components/homes/remember-context";
import { pageTitle } from "@/i18n/page-title";

interface PageProps {
  readonly params: Promise<{ readonly eventId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Calendar");
  return { title: await pageTitle(t("editEventTitle")) };
}

/** Changing a personal event (S32). */
export default async function Page({ params, searchParams }: PageProps) {
  const { userId } = await requireIdentity();
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "personal" }} />
      <EditEventPage
        home={null}
        eventId={(await params).eventId}
        searchParams={await searchParams}
      />
    </>
  );
}
