import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import {
  TemplateManager,
  type ManagedTemplate,
  type TemplateHome,
} from "@/components/dashboard/template-manager";
import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { listTemplates } from "@/dashboard/server";
import { getHomeContext, listMyHomes } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("DashboardTemplates");
  return { title: await pageTitle(t("title")) };
}

/**
 * The person's dashboard templates (S17; spec "dashboard customization": personal templates that
 * can be shared into Homes), reached from personal settings. Read with their own session: their
 * own templates, and those shared into Homes they belong to now.
 */
export default async function DashboardTemplatesPage() {
  await requireIdentity();
  const [t, result, myHomes] = await Promise.all([
    getTranslations("DashboardTemplates"),
    listTemplates(null),
    listMyHomes(),
  ]);
  const homeList = myHomes.status === "ok" ? myHomes.homes : [];
  // Whether the person may edit each Home's dashboard decides where Home templates may be shared.
  const contexts = await Promise.all(homeList.map((home) => getHomeContext(home.id)));
  const homes: TemplateHome[] = homeList.map((home, index) => {
    const found = contexts[index];
    return {
      id: home.id,
      name: home.name,
      canEditDashboard: found?.status === "ok" && found.context.permissions["home.dashboard.edit"],
    };
  });

  return (
    <>
      <PageHeader title={t("title")} />
      <p className="mb-4">
        <Link href="/settings" className="text-body font-medium text-accent-fg underline">
          {t("backToSettings")}
        </Link>
      </p>
      <p className="mb-6 max-w-2xl text-body text-fg-muted">{t("intro")}</p>
      {result.status === "ok" && myHomes.status === "ok" ? (
        <div className="max-w-2xl">
          <TemplateManager
            templates={result.templates.map((template): ManagedTemplate => ({
              id: template.id,
              name: template.name,
              kind: template.kind,
              widgets: template.layout.widgets.map((w) => w.type),
              isMine: template.isMine,
              sharedHomeIds: template.sharedHomeIds,
            }))}
            homes={homes}
          />
        </div>
      ) : (
        <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />
      )}
    </>
  );
}
