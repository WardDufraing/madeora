import { BellIcon } from "@madeora/icons";
import { useTranslations } from "next-intl";
import Link from "next/link";

/** The top bar's link to the notification centre, with the number of unread notifications. */
export function NotificationBell({ unread }: { readonly unread: number }) {
  const t = useTranslations("Shell");
  return (
    <Link
      href="/notifications"
      aria-label={unread > 0 ? t("notificationsUnread", { count: unread }) : t("notificationsLink")}
      data-testid="notification-bell"
      className="relative inline-flex min-h-10 min-w-10 items-center justify-center rounded-control text-fg hover:bg-accent-subtle"
    >
      <BellIcon />
      {unread > 0 ? (
        <span
          aria-hidden="true"
          data-testid="notification-count"
          className="absolute -end-0.5 -top-0.5 min-w-5 rounded-full bg-accent px-1 text-center text-helper font-semibold text-on-accent"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </Link>
  );
}
