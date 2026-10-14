import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { DEFAULT_ACCENT } from "@/accent/accent";
import { requireIdentity } from "@/auth/identity";
import { FormAlert } from "@/components/auth/form-alert";
import { HOME_UNAVAILABLE_PATH, loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { HomeProfileForm } from "@/components/members/home-profile-form";
import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { getHomeDirectory } from "@/members/directory";
import { getMyHomeProfile } from "@/members/profile";
import { getAccountPreferences } from "@/preferences/account";
import { noPreferences } from "@/preferences/schema";

interface ProfilePageProps {
  readonly params: Promise<{ readonly homeId: string }>;
}

export async function generateMetadata({ params }: ProfilePageProps): Promise<Metadata> {
  const found = await getHomeContext((await params).homeId);
  const [t, tHomes] = await Promise.all([getTranslations("Members"), getTranslations("Homes")]);
  return {
    title: await pageTitle(
      found.status === "ok"
        ? t("profilePageTitle", { home: found.context.home.name })
        : tHomes("homeFallbackTitle"),
    ),
  };
}

/**
 * "How you appear in this Home" (S11): the signed-in person's own nickname, Home display name and
 * colour in this Home. There is no page for anyone else's: nobody edits another adult's
 * presentation. The colour clash warning compares only with this Home's members.
 */
export default async function HomeProfilePage({ params }: ProfilePageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, t, tHomes] = await Promise.all([
    loadHomeForPage(homeId),
    getTranslations("Members"),
    getTranslations("Homes"),
  ]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  const { home, membership } = context;
  const [profile, account, directory] = await Promise.all([
    getMyHomeProfile(home.id),
    getAccountPreferences(),
    getHomeDirectory(home.id),
  ]);
  if (directory.status === "not-found") redirect(HOME_UNAVAILABLE_PATH);
  if (profile.status !== "ok") {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  const stored = account.status === "ok" ? account.preferences : noPreferences;
  const otherColors =
    directory.status === "ok"
      ? directory.members
          .filter((member) => !member.isSelf)
          .map((member) => member.accentColor ?? DEFAULT_ACCENT)
      : [];

  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: home.id }} />
      <PageHeader title={t("profileTitle")} />
      <p className="mb-4 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={`/homes/${home.id}/members`} className="font-medium text-accent-fg underline">
          {t("directoryLink")}
        </Link>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={`/homes/${home.id}`} className="font-medium text-accent-fg underline">
          {tHomes("backToHome")}
        </Link>
      </p>
      <p className="mb-6 max-w-2xl text-body text-fg-muted">{t("profileIntro")}</p>
      {account.status === "unavailable" || directory.status === "unavailable" ? (
        <FormAlert tone="error" className="mb-6 max-w-2xl">
          {t("profilePartlyLoaded")}
        </FormAlert>
      ) : null}
      <HomeProfileForm
        homeId={home.id}
        homeName={home.name}
        homeRole={membership.role}
        globalName={stored.displayName}
        globalAccent={stored.accentColor}
        overrides={profile.overrides}
        otherColors={otherColors}
      />
    </>
  );
}
