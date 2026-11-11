import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { FormAlert } from "@/components/auth/form-alert";
import { MyHomeCopies } from "@/components/copies/my-home-copies";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { listMyHomeCopies } from "@/copies/server";
import { pageTitle } from "@/i18n/page-title";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("HomeCopies");
  return { title: await pageTitle(t("mineTitle")) };
}

/** Settings › Privacy › Copies to Homes (S40 part 2): the person's own copy requests. */
export default async function MyHomeCopiesPage() {
  await requireIdentity();
  const [t, formats, copies] = await Promise.all([
    getTranslations("HomeCopies"),
    getDateTimeFormats(),
    listMyHomeCopies(),
  ]);

  return (
    <>
      <PageHeader title={t("mineTitle")} />
      <p className="mb-4">
        <Link href="/settings/privacy" className="text-body font-medium text-accent-fg underline">
          {t("backToPrivacy")}
        </Link>
      </p>
      <div className="flex max-w-2xl flex-col gap-6">
        <Card title={t("mineCardTitle")}>
          <p className="mb-4 text-body">{t("mineIntro")}</p>
          {copies.status === "ok" ? (
            <MyHomeCopies
              rows={copies.value.map((row) => ({
                id: row.id,
                homeName: row.homeName,
                itemType: row.itemType,
                label: row.label,
                status: row.status,
                code: row.code,
                selfApproved: row.selfApproved,
                requested: formatDateTime(row.requestedAt, formats),
                expires: formatDateTime(row.expiresAt, formats),
              }))}
            />
          ) : (
            <FormAlert tone="error">{t("unavailable")}</FormAlert>
          )}
        </Card>
      </div>
    </>
  );
}
