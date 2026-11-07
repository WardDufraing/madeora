import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { parseActivityCursor, parseActivityFilters } from "@/activity/filters";
import { listMyActivity, listMyActivityHomes } from "@/activity/server";
import { requireIdentity } from "@/auth/identity";
import { ActivityFiltersForm } from "@/components/activity/activity-filters";
import { ActivityList } from "@/components/activity/activity-list";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { pageTitle } from "@/i18n/page-title";
import { getDateTimeFormats } from "@/invitations/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Activity");
  return { title: await pageTitle(t("title")) };
}

interface ActivityPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const PATH = "/settings/activity";

/**
 * Settings › Activity history (S38): the signed-in person's own private record of significant
 * changes in five categories. Read with their own session; nobody else, whatever their Home role,
 * can see it. Personalized: never cached.
 */
export default async function ActivityHistoryPage({ searchParams }: ActivityPageProps) {
  await requireIdentity();
  const [t, params, formats] = await Promise.all([
    getTranslations("Activity"),
    searchParams,
    getDateTimeFormats(),
  ]);
  const filters = parseActivityFilters(params);
  const cursor = parseActivityCursor(params);
  const [page, homes] = await Promise.all([
    listMyActivity({ filters, cursor, timeZone: formats.timeZone }),
    listMyActivityHomes(),
  ]);

  return (
    <>
      <PageHeader title={t("title")} />
      <p className="mb-2 max-w-2xl text-body text-fg-muted">{t("hint")}</p>
      <p className="mb-4">
        <Link href="/settings" className="text-body font-medium text-accent-fg underline">
          {t("back")}
        </Link>
      </p>
      <div className="flex max-w-3xl flex-col gap-6">
        <Card>
          <ActivityFiltersForm action={PATH} filters={filters} homes={homes} />
          <ActivityList
            path={PATH}
            page={page.status === "ok" ? page.value : null}
            filters={filters}
            paged={cursor !== null}
            formats={formats}
          />
        </Card>
      </div>
    </>
  );
}
