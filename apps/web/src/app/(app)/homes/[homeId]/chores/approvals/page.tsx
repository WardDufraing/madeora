import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireIdentity } from "@/auth/identity";
import { ChoreApprovalsPage } from "@/components/chores/chore-approvals-page";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { ErrorState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";

interface HomeChoreApprovalsPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Chores");
  return { title: await pageTitle(t("approvalsTitle")) };
}

/** A Home's chore review queue (S20): chore reviewers only. */
export default async function HomeChoreApprovalsPage({ params }: HomeChoreApprovalsPageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, tHomes] = await Promise.all([loadHomeForPage(homeId), getTranslations("Homes")]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: context.home.id }} />
      <ChoreApprovalsPage home={{ id: context.home.id, name: context.home.name }} />
    </>
  );
}
