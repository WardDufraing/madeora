import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { HomeSettingsForm } from "@/components/homes/home-settings-form";
import { loadHomeForPage } from "@/components/homes/home-page";
import { RememberContext } from "@/components/homes/remember-context";
import { RoleLabel } from "@/components/homes/role-label";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import { getHomeContext } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { timeZoneChoices } from "@/preferences/timezone";

interface HomeSettingsPageProps {
  readonly params: Promise<{ readonly homeId: string }>;
}

export async function generateMetadata({ params }: HomeSettingsPageProps): Promise<Metadata> {
  const found = await getHomeContext((await params).homeId);
  const t = await getTranslations("Homes");
  return {
    title: await pageTitle(
      found.status === "ok"
        ? t("settingsPageTitle", { home: found.context.home.name })
        : t("homeFallbackTitle"),
    ),
  };
}

/**
 * A Home's settings (S09): name and scheduling timezone. Editable for people the permission
 * engine allows (the Owner, and from S12 Administrators granted the capability); shown read-only
 * to everyone else. The API and RLS check again on every save.
 */
export default async function HomeSettingsPage({ params }: HomeSettingsPageProps) {
  const { userId } = await requireIdentity();
  const { homeId } = await params;
  const [context, t, tStorage, tTrash] = await Promise.all([
    loadHomeForPage(homeId),
    getTranslations("Homes"),
    getTranslations("Storage"),
    getTranslations("Trash"),
  ]);
  if (!context) {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const { home, membership, permissions } = context;

  return (
    <>
      <RememberContext userId={userId} context={{ kind: "home", homeId: home.id }} />
      <PageHeader title={t("settingsTitle")} />
      <p className="mb-6 text-body text-fg-muted">
        <bdi className="font-semibold text-fg">{home.name}</bdi> {"\u{00B7}"}{" "}
        <RoleLabel role={membership.role} /> {"\u{00B7}"}{" "}
        <Link href={`/homes/${home.id}`} className="font-medium text-accent-fg underline">
          {t("backToHome")}
        </Link>
      </p>
      <Card title={t("generalSettings")} className="max-w-2xl">
        {permissions["home.updateSettings"] ? (
          <HomeSettingsForm home={home} timeZoneChoices={timeZoneChoices([home.timeZone])} />
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-body text-fg-muted">{t("settingsReadOnly")}</p>
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
              <dt className="text-body font-medium text-fg">{t("nameLabel")}</dt>
              <dd className="text-body text-fg">
                <bdi>{home.name}</bdi>
              </dd>
              <dt className="text-body font-medium text-fg">{t("timeZoneLabel")}</dt>
              <dd className="text-body text-fg">{home.timeZone.replaceAll("_", " ")}</dd>
            </dl>
          </div>
        )}
      </Card>
      {/* The Home's trash: every member may open it and sees what they may (S16). */}
      {permissions["home.trash.view"] ? (
        <Card title={tTrash("settingsCardTitle")} className="mt-6 max-w-2xl">
          <Link
            href={`/homes/${home.id}/trash`}
            className="text-body font-medium text-accent-fg underline"
            data-testid="home-trash-link"
          >
            {tTrash("homeSettingsLink")}
          </Link>
        </Card>
      ) : null}
      {/* Only decides whether to show the link; the storage page and the database check again. */}
      {permissions["home.storage.view"] ? (
        <Card title={tStorage("settingsCardTitle")} className="mt-6 max-w-2xl">
          <Link
            href={`/homes/${home.id}/storage`}
            className="text-body font-medium text-accent-fg underline"
            data-testid="home-storage-link"
          >
            {tStorage("homeSettingsLink")}
          </Link>
        </Card>
      ) : null}
    </>
  );
}
