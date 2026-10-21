import { useTranslations } from "next-intl";

import type { WidgetType } from "@/dashboard/widgets";

/**
 * Each widget type's name and what it shows, translated. Works in server and client components. A
 * new widget type fails the type check here until it has readable text.
 */
export function useWidgetLabels(): {
  readonly name: (type: WidgetType) => string;
  /** The name on the personal dashboard when it shows personal data, where it differs. */
  readonly personalName: (type: WidgetType) => string;
  readonly description: (type: WidgetType) => string;
} {
  const t = useTranslations("Dashboard");
  const names: { readonly [T in WidgetType]: string } = {
    welcome: t("widgetWelcome"),
    "quick-actions": t("widgetQuickActions"),
    notifications: t("widgetNotifications"),
    "home-members": t("widgetHomeMembers"),
    tasks: t("widgetTasks"),
  };
  const descriptions: { readonly [T in WidgetType]: string } = {
    welcome: t("widgetWelcomeDescription"),
    "quick-actions": t("widgetQuickActionsDescription"),
    notifications: t("widgetNotificationsDescription"),
    "home-members": t("widgetHomeMembersDescription"),
    tasks: t("widgetTasksDescription"),
  };
  const personalNames: { readonly [T in WidgetType]?: string } = {
    tasks: t("widgetPersonalTasks"),
  };
  return {
    name: (type) => names[type],
    personalName: (type) => personalNames[type] ?? names[type],
    description: (type) => descriptions[type],
  };
}
