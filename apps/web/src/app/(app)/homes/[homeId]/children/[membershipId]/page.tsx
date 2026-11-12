import { childPermissions } from "@madeora/domain/permissions";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { DEFAULT_ACCENT } from "@/accent/accent";
import { suggestDistinctColors } from "@/accent/similarity";
import { requireIdentity } from "@/auth/identity";
import { getChildSignInSettings } from "@/child-sign-in/server";
import { ChildSignInSettings } from "@/components/child-sign-in/child-sign-in-settings";
import { ChildAccessForm } from "@/components/children/child-access-form";
import { ChildGuardians } from "@/components/children/child-guardians";
import { ChildPresentationForm } from "@/components/children/child-presentation-form";
import { DeleteMistakenChild } from "@/components/children/delete-mistaken-child";
import { LinkCodeCard } from "@/components/children/link-code-card";
import { RemoveChild } from "@/components/children/remove-child";
import { FormAlert } from "@/components/auth/form-alert";
import { HOME_UNAVAILABLE_PATH, loadHomeForPage } from "@/components/homes/home-page";
import { MemberAvatar } from "@/components/members/member-avatar";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { getChildLinkCodeExpiry, getHomeChildren } from "@/children/server";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { getHomeDirectory } from "@/members/directory";

interface ChildPageProps {
  readonly params: Promise<{ readonly homeId: string; readonly membershipId: string }>;
  readonly searchParams: Promise<{
    readonly created?: string | string[];
    readonly linked?: string | string[];
  }>;
}

export async function generateMetadata({ params }: ChildPageProps): Promise<Metadata> {
  const { homeId, membershipId } = await params;
  const found = await getHomeContext(homeId);
  const [t, tHomes, tMembers] = await Promise.all([
    getTranslations("Children"),
    getTranslations("Homes"),
    getTranslations("Members"),
  ]);
  if (found.status !== "ok") return { title: await pageTitle(tHomes("homeFallbackTitle")) };
  const children = await getHomeChildren(found.context.home.id);
  const child =
    children.status === "ok"
      ? children.children.find((entry) => entry.membershipId === membershipId)
      : undefined;
  return {
    title: await pageTitle(
      child
        ? t("childPageTitle", {
            name: child.name ?? tMembers("noName"),
            home: found.context.home.name,
          })
        : t("childFallbackTitle"),
    ),
  };
}

/**
 * One child of a Home (S41). Every member sees the child's name and guardians; the child's
 * guardians here also see and manage their access, name and colour; the Owner appoints a primary
 * guardian when there is none and may remove the child from this Home. The page shows only what
 * the engine allows; the API and the database decide again for every action.
 */
export default async function ChildPage({ params, searchParams }: ChildPageProps) {
  await requireIdentity();
  const { homeId, membershipId } = await params;
  const [context, t, tHomes, tMembers] = await Promise.all([
    loadHomeForPage(homeId),
    getTranslations("Children"),
    getTranslations("Homes"),
    getTranslations("Members"),
  ]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  const { home, membership } = context;
  const [children, directory, formats, query] = await Promise.all([
    getHomeChildren(home.id),
    getHomeDirectory(home.id),
    getDateTimeFormats(),
    searchParams,
  ]);
  if (children.status === "not-found" || directory.status === "not-found") {
    redirect(HOME_UNAVAILABLE_PATH);
  }
  if (children.status === "unavailable" || directory.status === "unavailable") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const child = children.children.find((entry) => entry.membershipId === membershipId);
  if (!child) notFound();

  const name = child.name ?? tMembers("noName");
  const nameOf = (id: string | null) =>
    id === null
      ? null
      : (directory.members.find((member) => member.membershipId === id)?.name ??
        tMembers("noName"));
  const can = childPermissions({
    homeRole: membership.role,
    guardianRole: child.myGuardianRole,
    hasPrimaryGuardian: child.primaryGuardianMembershipId !== null,
  });
  const candidates = directory.members
    .filter(
      (member) =>
        member.isChild !== true &&
        member.isInactive !== true &&
        !member.isSelf &&
        member.membershipId !== child.primaryGuardianMembershipId,
    )
    .map((member) => ({
      membershipId: member.membershipId,
      name: member.name ?? tMembers("noName"),
    }));
  const ownRow = directory.members.find((member) => member.membershipId === child.membershipId);
  const otherColors = directory.members.flatMap((member) =>
    member.accentColor && member.membershipId !== child.membershipId ? [member.accentColor] : [],
  );
  const suggestedColor = suggestDistinctColors(otherColors, 1)[0]?.color ?? DEFAULT_ACCENT;
  const linkExpiryRead = can["child.link.issue"]
    ? getChildLinkCodeExpiry(home.id, child.membershipId)
    : null;
  const signInRead = child.myGuardianRole
    ? getChildSignInSettings(home.id, child.membershipId)
    : null;
  const [linkExpiry, signIn, tSignIn] = await Promise.all([
    linkExpiryRead,
    signInRead,
    getTranslations("ChildSignIn"),
  ]);
  const lockText = (value: string | null) =>
    value === null || value === "guardian" ? value : formatDateTime(value, formats);

  return (
    <>
      <PageHeader title={name} />
      <p className="mb-6 text-body text-fg-muted">
        <Link href={`/homes/${home.id}/members`} className="font-medium text-accent-fg underline">
          {t("backToMembers")}
        </Link>
      </p>
      {query.created === "1" ? (
        <FormAlert tone="success" className="mb-6">
          {t("createdNotice", { name })}
        </FormAlert>
      ) : null}
      {query.linked === "1" ? (
        <FormAlert tone="success" className="mb-6">
          {t("linkedNotice", { name })}
        </FormAlert>
      ) : null}
      <div className="flex flex-col gap-6">
        <Card title={t("profileTitle")} headingLevel={2}>
          <div className="flex items-center gap-3">
            <MemberAvatar
              name={child.name}
              accentColor={child.accentColor}
              locale={formats.locale}
              avatarFileId={ownRow?.avatarFileId ?? null}
            />
            <p className="text-body text-fg">{t("childProfileHint")}</p>
          </div>
        </Card>
        <Card title={t("guardiansTitle")} headingLevel={2}>
          <ChildGuardians
            homeId={home.id}
            membershipId={child.membershipId}
            primaryName={nameOf(child.primaryGuardianMembershipId)}
            secondaryName={nameOf(child.secondaryGuardianMembershipId)}
            hasSecondary={child.secondaryGuardianMembershipId !== null}
            pendingPrimaryName={nameOf(child.pendingPrimaryMembershipId)}
            pendingSecondaryName={nameOf(child.pendingSecondaryMembershipId)}
            pendingPrimaryOfferId={child.pendingPrimaryOfferId}
            pendingSecondaryOfferId={child.pendingSecondaryOfferId}
            candidates={candidates}
            canAssignSecondary={can["child.guardian.assignSecondary"]}
            canHandOverPrimary={can["child.guardian.handOverPrimary"]}
            canAppointPrimary={can["child.guardian.appointPrimary"]}
            canRemoveSecondary={can["child.guardian.removeSecondary"]}
            isSecondary={child.myGuardianRole === "secondary"}
          />
        </Card>
        {child.access && child.myGuardianRole ? (
          <Card title={t("accessTitle")} headingLevel={2}>
            <ChildAccessForm
              homeId={home.id}
              membershipId={child.membershipId}
              childName={name}
              guardianRole={child.myGuardianRole}
              preset={child.access.preset}
              overrides={child.access.overrides}
              updatedAt={child.access.updatedAt}
            />
          </Card>
        ) : (
          <Card title={t("accessTitle")} headingLevel={2}>
            <p className="text-body text-fg-muted">{t("accessGuardiansOnly")}</p>
          </Card>
        )}
        {signIn && child.myGuardianRole ? (
          <Card title={tSignIn("guardianTitle")} headingLevel={2}>
            <ChildSignInSettings
              homeId={home.id}
              membershipId={child.membershipId}
              childName={name}
              isPrimary={child.myGuardianRole === "primary"}
              settings={{
                username: signIn.username,
                hasPassword: signIn.hasPassword,
                hasPin: signIn.hasPin,
                passwordSignIn: signIn.passwordSignIn,
                pinSignIn: signIn.pinSignIn,
                passwordLock: lockText(signIn.passwordLockedUntil),
                pinLock: lockText(signIn.pinLockedUntil),
                activeSessions: signIn.activeSessions,
              }}
            />
          </Card>
        ) : null}
        {can["child.presentation.change"] ? (
          <Card title={t("presentationTitle")} headingLevel={2}>
            <ChildPresentationForm
              homeId={home.id}
              membershipId={child.membershipId}
              displayName={child.name}
              accentColor={child.accentColor ?? suggestedColor}
              suggestedColor={suggestedColor}
            />
          </Card>
        ) : null}
        {can["child.link.issue"] ? (
          <Card title={t("linkCardTitle")} headingLevel={2}>
            <LinkCodeCard
              homeId={home.id}
              membershipId={child.membershipId}
              childName={name}
              openUntil={linkExpiry === null ? null : formatDateTime(linkExpiry, formats)}
            />
          </Card>
        ) : null}
        {child.canDelete ? (
          <Card title={t("deleteTitle")} headingLevel={2}>
            <DeleteMistakenChild
              homeId={home.id}
              membershipId={child.membershipId}
              childName={name}
            />
          </Card>
        ) : null}
        {can["child.remove"] ? (
          <Card title={t("removeTitle")} headingLevel={2}>
            <RemoveChild
              homeId={home.id}
              homeName={home.name}
              membershipId={child.membershipId}
              childName={name}
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
