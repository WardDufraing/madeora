import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { DEFAULT_ACCENT } from "@/accent/accent";
import { suggestDistinctColors } from "@/accent/similarity";
import { requireIdentity } from "@/auth/identity";
import { LinkChildForm } from "@/components/children/link-child-form";
import { HOME_UNAVAILABLE_PATH, loadHomeForPage } from "@/components/homes/home-page";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { getHomeDirectory } from "@/members/directory";

interface LinkChildPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
}

export async function generateMetadata({ params }: LinkChildPageProps): Promise<Metadata> {
  const found = await getHomeContext((await params).homeId);
  const [t, tHomes] = await Promise.all([getTranslations("Children"), getTranslations("Homes")]);
  return {
    title: await pageTitle(
      found.status === "ok"
        ? t("linkPageTitle", { home: found.context.home.name })
        : tHomes("homeFallbackTitle"),
    ),
  };
}

/**
 * Link an existing child to this Home with a code from their primary guardian in another Home
 * (S41). The database decides who may redeem (`public.redeem_child_link_code`).
 */
export default async function LinkChildPage({ params }: LinkChildPageProps) {
  await requireIdentity();
  const { homeId } = await params;
  const [context, t, tHomes, tMembers] = await Promise.all([
    loadHomeForPage(homeId),
    getTranslations("Children"),
    getTranslations("Homes"),
    getTranslations("Members"),
  ]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  const { home } = context;
  const directory = await getHomeDirectory(home.id);
  if (directory.status === "not-found") redirect(HOME_UNAVAILABLE_PATH);
  if (directory.status === "unavailable") {
    return (
      <ErrorState
        title={tMembers("directoryFailedTitle")}
        description={tMembers("directoryFailed")}
      />
    );
  }
  const self = directory.members.find((member) => member.isSelf);
  if (!self || self.isChild === true) redirect(`/homes/${home.id}/members`);
  const otherColors = directory.members.flatMap((member) =>
    member.accentColor ? [member.accentColor] : [],
  );
  const suggestedColor = suggestDistinctColors(otherColors, 1)[0]?.color ?? DEFAULT_ACCENT;

  return (
    <>
      <PageHeader title={t("linkTitle")} />
      <p className="mb-6 text-body text-fg-muted">
        <Link href={`/homes/${home.id}/members`} className="font-medium text-accent-fg underline">
          {t("backToMembers")}
        </Link>
      </p>
      <Card>
        <LinkChildForm homeId={home.id} suggestedColor={suggestedColor} />
      </Card>
    </>
  );
}
