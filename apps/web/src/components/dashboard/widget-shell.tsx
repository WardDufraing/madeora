"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { OverflowMenu, type OverflowMenuItem } from "@/components/ui/overflow-menu";
import { hasSettings } from "@/dashboard/widgets";
import type { WidgetEntry } from "@/dashboard/view-types";

import { WidgetFrame } from "./dashboard-grid";

/**
 * A widget in normal use (UX2a; redesign decisions 18 and 20): the title and one three-dot menu,
 * the same on every widget. The menu only offers what the person may do and what means something
 * for this widget: open its full view, its settings (people who may edit the dashboard), refresh,
 * and Customize dashboard, which is where moving, resizing and removing live (never here, so
 * nothing is moved or removed by accident). Positions are never touched from this menu.
 */
export function WidgetShell({
  entry,
  canEdit,
  onSettings,
  onCustomize,
}: {
  readonly entry: WidgetEntry;
  readonly canEdit: boolean;
  readonly onSettings: (widgetId: string) => void;
  readonly onCustomize: () => void;
}) {
  const t = useTranslations("Dashboard");
  const router = useRouter();
  const [, startRefresh] = useTransition();

  const items: OverflowMenuItem[] = [];
  if (!entry.unavailable) {
    if (entry.href) {
      const href = entry.href;
      items.push({
        id: "open",
        label: t("menuOpen"),
        onSelect: () => {
          router.push(href);
        },
      });
    }
    if (canEdit && hasSettings(entry.type)) {
      items.push({
        id: "settings",
        label: t("menuSettings"),
        onSelect: () => {
          onSettings(entry.id);
        },
      });
    }
    items.push({
      id: "refresh",
      label: t("menuRefresh"),
      onSelect: () => {
        startRefresh(() => {
          router.refresh();
        });
      },
    });
  }
  if (canEdit) {
    items.push({ id: "customize", label: t("menuCustomize"), onSelect: onCustomize });
  }

  return (
    <WidgetFrame
      widget={entry}
      actions={
        items.length > 0 ? (
          <OverflowMenu label={t("menuLabel", { widget: entry.title })} items={items} />
        ) : undefined
      }
    >
      {entry.body}
    </WidgetFrame>
  );
}
