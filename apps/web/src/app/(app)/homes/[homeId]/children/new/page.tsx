import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { DEFAULT_ACCENT } from "@/accent/accent";
import { suggestDistinctColors } from "@/accent/similarity";
import { requireIdentity } from "@/auth/identity";
import { AddChildForm, type GuardianOption } from "@/components/children/add-child-form";
import { HOME_UNAVAILABLE_PATH, loadHomeForPage } from "@/components/homes/home-page";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { getHomeDirectory } from "@/members/directory";

interface AddChildPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
}

export async function generateMetadata({ params }: AddChildPageProps): Promise<Metadata> {
  const found = await getHomeContext((await params).homeId);
  const [t, tHomes] = await Promise.all([getTranslations("Children"), getTranslations("Homes")]);
  return {
    title: await pageTitle(
      found.status === "ok"
        ? t("addPageTitle", { home: found.context.home.name })
        : tHomes("homeFallbackTitle"),
    ),
  };
}

/**
 * Home → Members → Add child (S41). Any adult member may add a child with themselves as primary
 * guardian; the Owner and Administrators allowed to add members may name another adult member.
 * The database decides again (`public.create_child`).
 */
export default async function AddChildPage({ params }: AddChildPageProps) {
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
  const { home, permissions } = context;
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
  // A child cannot add children (from S42, when children can sign in).
  if (!self || self.isChild === true) redirect(`/homes/${home.id}/members`);

  const canNameOthers = permissions["home.invitations.manage"];
  const adults = directory.members.filter(
    (member) => member.isChild !== true && member.isInactive !== true,
  );
  const guardianOptions: GuardianOption[] = [
    { membershipId: self.membershipId, name: self.name ?? tMembers("noName") },
    ...(canNameOthers
      ? adults
          .filter((member) => !member.isSelf)
          .map((member) => ({
            membershipId: member.membershipId,
            name: member.name ?? tMembers("noName"),
          }))
      : []),
  ];
  const otherColors = directory.members.flatMap((member) =>
    member.accentColor ? [member.accentColor] : [],
  );
  const suggestedColor = suggestDistinctColors(otherColors, 1)[0]?.color ?? DEFAULT_ACCENT;

  return (
    <>
      <PageHeader title={t("addTitle")} />
      <p className="mb-6 text-body text-fg-muted">
        <Link href={`/homes/${home.id}/members`} className="font-medium text-accent-fg underline">
          {t("backToMembers")}
        </Link>
      </p>
      <Card>
        <AddChildForm
          homeId={home.id}
          guardianOptions={guardianOptions}
          defaultGuardianMembershipId={self.membershipId}
          suggestedColor={suggestedColor}
        />
      </Card>
    </>
  );
}
