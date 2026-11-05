import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { GoogleEventPage } from "@/components/google-calendar/google-event-page";
import { RememberContext } from "@/components/homes/remember-context";
import { pageTitle } from "@/i18n/page-title";

interface PageProps {
  readonly params: Promise<{ readonly eventId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Calendar");
  return { title: await pageTitle(t("eventPageTitle")) };
}

/** One of the person's own Google events on their personal calendar (S33), read-only. */
export default async function Page({ params }: PageProps) {
  const { userId } = await requireIdentity();
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "personal" }} />
      <GoogleEventPage home={null} eventId={(await params).eventId} />
    </>
  );
}
