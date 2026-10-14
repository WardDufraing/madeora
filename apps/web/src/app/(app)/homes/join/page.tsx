import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { JoinCodeForm } from "@/components/invitations/join-code-form";
import { MyJoinRequests } from "@/components/invitations/my-join-requests";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";
import { getDateTimeFormats, listMyJoinRequests } from "@/invitations/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Homes");
  return { title: await pageTitle(t("joinTitle")) };
}

/**
 * "Join a Home" (S10): enter a join code, and the person's own join requests with their states.
 * Invitation links open `/join/{token}` directly.
 */
export default async function JoinHomePage() {
  await requireIdentity();
  const [t, tHomes, requests, formats] = await Promise.all([
    getTranslations("Invitations"),
    getTranslations("Homes"),
    listMyJoinRequests(),
    getDateTimeFormats(),
  ]);
  return (
    <>
      <PageHeader title={tHomes("joinTitle")} />
      <div className="flex max-w-2xl flex-col gap-6">
        <Card title={t("codeTitle")} description={t("codeDescription")}>
          <JoinCodeForm />
        </Card>
        <Card title={t("myRequestsTitle")}>
          {requests.status === "ok" ? (
            <MyJoinRequests requests={requests.items} formats={formats} />
          ) : (
            <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
          )}
        </Card>
      </div>
    </>
  );
}
