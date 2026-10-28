"use client";

import { SidebarCollapseIcon, SidebarExpandIcon } from "@madeora/icons";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { cx } from "@/components/ui/cx";
import { saveSidebar } from "@/preferences/client";
import type { SidebarState } from "@/preferences/preferences";

import { Brand } from "./brand";
import { NavLink } from "./nav-link";
import {
  contextHref,
  homeIdFromPath,
  isItemActive,
  primaryNav,
  secondaryNav,
  type NavItem,
} from "./nav-items";

export interface SidebarProps {
  /** The state saved on this device, read by the server so the first paint is right. */
  readonly initialState: SidebarState;
}

/**
 * The persistent desktop sidebar: expanded (~240px, icons and labels) or collapsed (~72px, icons
 * only). Collapsing gives the width back to the main content. Hidden below the `md` breakpoint,
 * where the menu in the top bar takes over.
 */
export function Sidebar({ initialState }: SidebarProps) {
  const t = useTranslations("Shell");
  const tNav = useTranslations("Nav");
  const pathname = usePathname();
  const [state, setState] = useState(initialState);
  const [tooltipHidden, setTooltipHidden] = useState(false);
  const collapsed = state === "collapsed";

  function toggle() {
    const next: SidebarState = collapsed ? "expanded" : "collapsed";
    setState(next);
    saveSidebar(next);
  }

  // Escape hides a visible tooltip without moving focus or the pointer (WCAG 1.4.13). The next
  // item the pointer or focus reaches shows its tooltip again.
  useEffect(() => {
    if (!collapsed) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setTooltipHidden(true);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [collapsed]);

  function showTooltips() {
    setTooltipHidden(false);
  }

  const ToggleIcon = collapsed ? SidebarExpandIcon : SidebarCollapseIcon;
  const toggleButton = (
    <button
      type="button"
      onClick={toggle}
      aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
      className="inline-flex size-10 shrink-0 items-center justify-center rounded-control text-fg-muted hover:bg-accent-subtle hover:text-fg"
    >
      {/* The arrow points towards the edge it moves to, so it mirrors in right-to-left layouts. */}
      <ToggleIcon className="rtl:-scale-x-100" />
    </button>
  );

  const homeId = homeIdFromPath(pathname);
  const renderItems = (items: readonly NavItem[]) => (
    <ul className="flex flex-col gap-1">
      {items.map((item) => (
        <li key={item.id}>
          <NavLink
            item={item}
            href={contextHref(item, homeId)}
            label={tNav(item.id)}
            active={isItemActive(item, homeId, pathname)}
            collapsed={collapsed}
            tooltipHidden={tooltipHidden}
            onPointerEnter={showTooltips}
            onFocus={showTooltips}
          />
        </li>
      ))}
    </ul>
  );

  return (
    <aside
      data-state={state}
      className={cx(
        "sticky top-0 hidden h-dvh shrink-0 flex-col border-e border-line bg-sidebar md:flex",
        "transition-[width] duration-(--md-duration-slow) ease-standard",
        collapsed ? "w-(--md-shell-sidebar-collapsed)" : "w-(--md-shell-sidebar-expanded)",
      )}
    >
      <div
        className={cx(
          "flex gap-2 p-3",
          collapsed ? "flex-col items-center" : "items-center justify-between",
        )}
      >
        <Brand label={t("brandLink")} showWordmark={!collapsed} />
        {toggleButton}
      </div>
      <nav
        aria-label={t("mainNavigation")}
        className="flex min-h-0 flex-1 flex-col justify-between gap-6 overflow-y-auto px-3 pt-1 pb-3"
      >
        {renderItems(primaryNav)}
        {renderItems(secondaryNav)}
      </nav>
    </aside>
  );
}
