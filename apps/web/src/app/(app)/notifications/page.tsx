import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { requireIdentity } from "@/auth/identity";
import { FormAlert } from "@/components/auth/form-alert";
import { NotificationList } from "@/components/notifications/notification-list";
import { PageHeader } from "@/components/shell/page-header";
import { pageTitle } from "@/i18n/page-title";
import { getDateTimeFormats } from "@/invitations/server";
import { listNotifications } from "@/notifications/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Notifications");
  return { title: await pageTitle(t("title")) };
}

/**
 * The notification centre (S14): the person's own in-app notifications, newest first. In-app
 * delivery never depends on email, so this page is complete even when no email was ever sent.
 */
export default async function NotificationsPage() {
  await requireIdentity();
  const [t, notifications, formats] = await Promise.all([
    getTranslations("Notifications"),
    listNotifications(),
    getDateTimeFormats(),
  ]);

  return (
    <>
      <PageHeader title={t("title")} />
      <div className="flex max-w-3xl flex-col gap-4">
        <p>
          <Link
            href="/settings/notifications"
            className="text-body font-medium text-accent-fg underline"
          >
            {t("settingsLink")}
          </Link>
        </p>
        {notifications.status === "unavailable" ? (
          <FormAlert tone="error">{t("loadFailed")}</FormAlert>
        ) : (
          <NotificationList items={notifications.value} formats={formats} />
        )}
      </div>
    </>
  );
}
