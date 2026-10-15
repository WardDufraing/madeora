import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireIdentity } from "@/auth/identity";
import { FormAlert } from "@/components/auth/form-alert";
import { staffStateKey } from "@/components/recovery/staff-state-label";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/states";
import { pageTitle } from "@/i18n/page-title";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { getStaffQueue } from "@/recovery/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Recovery");
  return { title: await pageTitle(t("staffQueueTitle")) };
}

/**
 * Madeora staff: every ownership recovery case, newest first (S12b; architecture.md §43). Shows no
 * statements; opening a case is audited. Anyone who is not staff gets a plain 404, as if the page
 * did not exist; the database decides who is staff.
 */
export default async function StaffRecoveriesPage() {
  await requireIdentity();
  const [queue, t, formats] = await Promise.all([
    getStaffQueue(),
    getTranslations("Recovery"),
    getDateTimeFormats(),
  ]);
  if (queue.status === "not-staff") notFound();

  return (
    <>
      <PageHeader title={t("staffQueueTitle")} />
      <p className="mb-6 max-w-2xl text-body text-fg-muted">{t("staffQueueIntro")}</p>
      {queue.status === "unavailable" ? (
        <FormAlert tone="error">{t("loadFailed")}</FormAlert>
      ) : queue.value.length === 0 ? (
        <EmptyState title={t("staffQueueEmptyTitle")} description={t("staffQueueEmpty")} />
      ) : (
        <Card>
          <ul className="divide-y divide-line" aria-label={t("staffQueueTitle")}>
            {queue.value.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3"
                data-testid="staff-case"
              >
                <Link
                  href={`/staff/ownership-recoveries/${item.id}`}
                  className="min-w-0 flex-1 text-body font-medium text-accent-fg underline"
                >
                  <bdi>{item.homeName}</bdi>
                </Link>
                <span className="text-body text-fg">{t(staffStateKey[item.state])}</span>
                <span className="text-helper text-fg-muted">
                  {t("staffSubmittedOn", { date: formatDateTime(item.createdAt, formats) })}
                </span>
                {item.objections > 0 ? (
                  <span className="text-helper text-fg">
                    {t("staffObjectionCount", { count: item.objections })}
                  </span>
                ) : null}
                {item.openAppeals > 0 ? (
                  <span className="text-helper text-fg">
                    {t("staffAppealCount", { count: item.openAppeals })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
