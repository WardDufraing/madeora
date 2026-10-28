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
    "my-chores": t("widgetMyChores"),
    "home-chores": t("widgetHomeChores"),
    "chore-approvals": t("widgetChoreApprovals"),
    "chore-schedule": t("widgetChoreSchedule"),
    "home-vacation": t("widgetHomeVacation"),
    "weekly-points": t("widgetWeeklyPoints"),
    "points-leaderboard": t("widgetPointsLeaderboard"),
    "my-points": t("widgetMyPoints"),
    recipes: t("widgetRecipes"),
    shopping: t("widgetShopping"),
  };
  const descriptions: { readonly [T in WidgetType]: string } = {
    welcome: t("widgetWelcomeDescription"),
    "quick-actions": t("widgetQuickActionsDescription"),
    notifications: t("widgetNotificationsDescription"),
    "home-members": t("widgetHomeMembersDescription"),
    tasks: t("widgetTasksDescription"),
    "my-chores": t("widgetMyChoresDescription"),
    "home-chores": t("widgetHomeChoresDescription"),
    "chore-approvals": t("widgetChoreApprovalsDescription"),
    "chore-schedule": t("widgetChoreScheduleDescription"),
    "home-vacation": t("widgetHomeVacationDescription"),
    "weekly-points": t("widgetWeeklyPointsDescription"),
    "points-leaderboard": t("widgetPointsLeaderboardDescription"),
    "my-points": t("widgetMyPointsDescription"),
    recipes: t("widgetRecipesDescription"),
    shopping: t("widgetShoppingDescription"),
  };
  const personalNames: { readonly [T in WidgetType]?: string } = {
    tasks: t("widgetPersonalTasks"),
    recipes: t("widgetPersonalRecipes"),
    shopping: t("widgetPersonalShopping"),
  };
  return {
    name: (type) => names[type],
    personalName: (type) => personalNames[type] ?? names[type],
    description: (type) => descriptions[type],
  };
}
