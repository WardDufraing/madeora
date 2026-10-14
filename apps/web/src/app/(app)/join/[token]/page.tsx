import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { JoinInvitation } from "@/components/invitations/join-invitation";
import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";
import { getDateTimeFormats, previewInvitation } from "@/invitations/server";

interface JoinPageProps {
  readonly params: Promise<{ readonly token: string }>;
}

// A generic title: the Home's name is shown only after the server checked the link for this person.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Invitations");
  return { title: await pageTitle(t("joinPageTitle")), referrer: "no-referrer" };
}

/**
 * An invitation link or join code (S10). Signed-out visitors are sent to sign in first and come
 * back here (the (app) layout). The secret is read from the path and checked by the database for
 * this person; a failed lookup counts toward their guessing limit.
 */
export default async function JoinPage({ params }: JoinPageProps) {
  await requireIdentity();
  const { token } = await params;
  const [result, formats, t] = await Promise.all([
    previewInvitation(token),
    getDateTimeFormats(),
    getTranslations("Invitations"),
  ]);
  return (
    <>
      <PageHeader title={t("joinPageTitle")} />
      {result.status === "ok" ? (
        <JoinInvitation token={token} preview={result.preview} formats={formats} />
      ) : (
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      )}
    </>
  );
}
