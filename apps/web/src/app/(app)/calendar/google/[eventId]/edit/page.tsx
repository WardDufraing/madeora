import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { GoogleEditPage } from "@/components/google-calendar/google-edit-page";
import { RememberContext } from "@/components/homes/remember-context";
import { pageTitle } from "@/i18n/page-title";

interface PageProps {
  readonly params: Promise<{ readonly eventId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Calendar");
  return { title: await pageTitle(t("editEventTitle")) };
}

/** Changing one of the person's own Google events from Madeora (S34). */
export default async function Page({ params }: PageProps) {
  const { userId } = await requireIdentity();
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "personal" }} />
      <GoogleEditPage eventId={(await params).eventId} />
    </>
  );
}
