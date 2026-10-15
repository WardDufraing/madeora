import { memberPermissions } from "@madeora/domain/permissions";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { requireIdentity } from "@/auth/identity";
import { HOME_UNAVAILABLE_PATH, loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { FormAlert } from "@/components/auth/form-alert";
import { RoleLabel } from "@/components/homes/role-label";
import { MemberDirectory } from "@/components/members/member-directory";
import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { getDateTimeFormats } from "@/invitations/server";
import { getHomeDirectory } from "@/members/directory";
import {
  arrangeDirectory,
  nameCollator,
  parseDirectoryQuery,
  sharedNameIds,
} from "@/members/directory-view";

interface MembersPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
  readonly searchParams: Promise<{
    readonly sort?: string | string[];
    readonly role?: string | string[];
    readonly removed?: string | string[];
  }>;
}

export async function generateMetadata({ params }: MembersPageProps): Promise<Metadata> {
  const found = await getHomeContext((await params).homeId);
  const [t, tHomes] = await Promise.all([getTranslations("Members"), getTranslations("Homes")]);
  return {
    title: await pageTitle(
      found.status === "ok"
        ? t("directoryPageTitle", { home: found.context.home.name })
        : tHomes("homeFallbackTitle"),
    ),
  };
}

/**
 * A Home's member directory (S11). Every current member sees it; the list comes from
 * `public.home_directory`, which re-checks the membership itself and returns only what members may
 * see of each other. Managers also get a link to invitations, which stay separate from members.
 */
export default async function MembersPage({ params, searchParams }: MembersPageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, t, tHomes, tManage, tRecovery] = await Promise.all([
    loadHomeForPage(homeId),
    getTranslations("Members"),
    getTranslations("Homes"),
    getTranslations("Manage"),
    getTranslations("Recovery"),
  ]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  const { home, membership, permissions } = context;
  // Every member may see the directory today; the engine decides, so later restrictions (children,
  // Household Displays) apply here too. The database function checks the membership again.
  if (!permissions["home.members.view"]) redirect(HOME_UNAVAILABLE_PATH);
  const [directory, formats, rawParams] = await Promise.all([
    getHomeDirectory(home.id),
    getDateTimeFormats(),
    searchParams,
  ]);
  const query = parseDirectoryQuery(rawParams);
  // The membership ended between the two reads: the same neutral notice as any lost Home.
  if (directory.status === "not-found") redirect(HOME_UNAVAILABLE_PATH);

  const header = (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: home.id }} />
      <PageHeader title={t("directoryTitle")} />
      <p className="mb-6 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <RoleLabel role={membership.role} />
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={`/homes/${home.id}`} className="font-medium text-accent-fg underline">
          {tHomes("backToHome")}
        </Link>
        {permissions["home.invitations.manage"] ? (
          <>
            <span aria-hidden="true">{"\u{00B7}"}</span>
            <Link
              href={`/homes/${home.id}/invitations`}
              className="font-medium text-accent-fg underline"
            >
              {t("invitationsLink")}
            </Link>
          </>
        ) : null}
      </p>
      {rawParams.removed === "1" ? (
        <FormAlert tone="success" className="mb-6">
          {tManage("removedNotice")}
        </FormAlert>
      ) : null}
    </>
  );
  if (directory.status === "unavailable") {
    return (
      <>
        {header}
        <ErrorState title={t("directoryFailedTitle")} description={t("directoryFailed")} />
      </>
    );
  }

  const collator = nameCollator(formats.locale);
  // The members this viewer may act on, so their rows link to their page. The page and the API
  // decide again for each action.
  const manageable = new Set(
    directory.members
      .filter((member) =>
        Object.values(
          memberPermissions(membership, {
            homeId: home.id,
            role: member.role,
            isSelf: member.isSelf,
          }),
        ).some(Boolean),
      )
      .map((member) => member.membershipId),
  );
  return (
    <>
      {header}
      <MemberDirectory
        homeId={home.id}
        shown={arrangeDirectory(directory.members, query, collator)}
        all={directory.members}
        total={directory.members.length}
        query={query}
        sharedNames={sharedNameIds(directory.members, collator)}
        manageable={manageable}
        formats={formats}
      />
      {permissions["home.recovery.request"] ? (
        <p className="mt-6 text-body text-fg-muted" data-testid="recovery-link">
          {tRecovery("cannotReachOwner")}{" "}
          <Link
            href={`/homes/${home.id}/recovery`}
            className="font-medium text-accent-fg underline"
          >
            {tRecovery("cannotReachOwnerLink")}
          </Link>
        </p>
      ) : null}
    </>
  );
}
