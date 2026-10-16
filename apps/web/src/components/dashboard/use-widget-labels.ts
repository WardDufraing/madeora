import { useTranslations } from "next-intl";

import type { WidgetType } from "@/dashboard/widgets";

/**
 * Each widget type's name and what it shows, translated. Works in server and client components. A
 * new widget type fails the type check here until it has readable text.
 */
export function useWidgetLabels(): {
  readonly name: (type: WidgetType) => string;
  readonly description: (type: WidgetType) => string;
} {
  const t = useTranslations("Dashboard");
  const names: { readonly [T in WidgetType]: string } = {
    welcome: t("widgetWelcome"),
    "quick-actions": t("widgetQuickActions"),
    notifications: t("widgetNotifications"),
    "home-members": t("widgetHomeMembers"),
  };
  const descriptions: { readonly [T in WidgetType]: string } = {
    welcome: t("widgetWelcomeDescription"),
    "quick-actions": t("widgetQuickActionsDescription"),
    notifications: t("widgetNotificationsDescription"),
    "home-members": t("widgetHomeMembersDescription"),
  };
  return { name: (type) => names[type], description: (type) => descriptions[type] };
}
