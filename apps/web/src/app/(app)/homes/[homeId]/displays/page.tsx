import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { HouseholdDisplaysManager } from "@/components/displays/household-displays-manager";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { getHouseholdDisplays } from "@/displays/server";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { getHomeDirectory } from "@/members/directory";

interface HomeDisplaysPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
}

export async function generateMetadata({ params }: HomeDisplaysPageProps): Promise<Metadata> {
  const found = await getHomeContext((await params).homeId);
  const [t, tHomes] = await Promise.all([getTranslations("Displays"), getTranslations("Homes")]);
  return {
    title: await pageTitle(
      found.status === "ok"
        ? t("pageTitle", { home: found.context.home.name })
        : tHomes("homeFallbackTitle"),
    ),
  };
}

const KINDS = ["phone", "tablet", "computer", "unknown"] as const;
const BROWSERS = ["edge", "chrome", "firefox", "safari", "samsung", "opera", "other"] as const;
const PLATFORMS = [
  "windows",
  "macos",
  "ios",
  "ipados",
  "android",
  "linux",
  "chromeos",
  "other",
] as const;

/**
 * Home → Household Displays (S43; spec "Confirmed manager-approved pairing for household
 * displays"): the Owner, or an Administrator granted manageHomeSettings, pairs tablets as this
 * Home's displays and manages them. Everyone else is told the page is not for them; the API and
 * the database check again on every action.
 */
export default async function HomeDisplaysPage({ params }: HomeDisplaysPageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, t, tHomes, tSecurity, tMembers, formats] = await Promise.all([
    loadHomeForPage(homeId),
    getTranslations("Displays"),
    getTranslations("Homes"),
    getTranslations("Security"),
    getTranslations("Members"),
    getDateTimeFormats(),
  ]);
  if (!context) {
    return <ErrorState title={tHomes("loadFailedTitle")} description={tHomes("loadFailed")} />;
  }
  const { home, permissions } = context;
  const manager = permissions["home.updateSettings"];
  const [displays, directory] = manager
    ? await Promise.all([getHouseholdDisplays(home.id), getHomeDirectory(home.id)])
    : [null, null];

  const words = {
    kind: Object.fromEntries(KINDS.map((key) => [key, tSecurity(`kind.${key}`)])),
    browser: Object.fromEntries(BROWSERS.map((key) => [key, tSecurity(`browser.${key}`)])),
    platform: Object.fromEntries(PLATFORMS.map((key) => [key, tSecurity(`platform.${key}`)])),
  };
  const deviceText = (kind: string, browser: string, platform: string): string =>
    t("deviceDescription", {
      kind: words.kind[kind] ?? words.kind["unknown"] ?? "",
      browser: words.browser[browser] ?? words.browser["other"] ?? "",
      platform: words.platform[platform] ?? words.platform["other"] ?? "",
    });

  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: home.id }} />
      <PageHeader title={t("title")} />
      <p className="mb-4 flex flex-wrap gap-x-2 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi>
        <span aria-hidden="true">{"\u{00B7}"}</span>
        <Link href={`/homes/${home.id}/settings`} className="font-medium text-accent-fg underline">
          {tHomes("settingsTitle")}
        </Link>
      </p>
      {!manager ? (
        <EmptyState title={t("notManagerTitle")} description={t("notManager")} />
      ) : displays === null ? (
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      ) : (
        <Card className="max-w-2xl">
          <p className="mb-6 text-body text-fg-muted">{t("intro")}</p>
          <HouseholdDisplaysManager
            homeId={home.id}
            words={words}
            displays={displays.map((display) => ({
              id: display.id,
              name: display.name,
              active: display.status === "active",
              device: deviceText(display.deviceKind, display.browser, display.platform),
              pairedAt: formatDateTime(display.pairedAt, formats),
              pairedBy:
                directory.status === "ok"
                  ? (directory.members.find(
                      (member) => member.membershipId === display.pairedByMembershipId,
                    )?.name ?? (display.pairedByMembershipId ? tMembers("noName") : null))
                  : null,
              lastSeenAt: display.lastSeenAt ? formatDateTime(display.lastSeenAt, formats) : null,
              revokedAt: display.revokedAt ? formatDateTime(display.revokedAt, formats) : null,
            }))}
          />
        </Card>
      )}
    </>
  );
}
