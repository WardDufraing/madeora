"use client";

import { ModulesIcon, SidebarCollapseIcon, SidebarExpandIcon } from "@madeora/icons";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";

import { cx } from "@/components/ui/cx";
import { saveSidebar } from "@/preferences/client";
import type { SidebarState } from "@/preferences/preferences";

import { Brand } from "./brand";
import { useFavorites } from "./favorites";
import { NavLink } from "./nav-link";
import {
  contextHref,
  coreNav,
  homeIdFromPath,
  isActive,
  isItemActive,
  modulesHref,
  moduleNav,
  secondaryNav,
  type NavItem,
} from "./nav-items";

/** All modules is a destination of its own, not a module, so it has no `NavId`. */
const allModulesItem = { icon: ModulesIcon };

export interface SidebarProps {
  /** The state saved on this device, read by the server so the first paint is right. */
  readonly initialState: SidebarState;
}

/**
 * The persistent desktop navigation (redesign decisions 10 and 41): a softly raised, rounded
 * surface that floats inside the shell. Dashboard, Calendar and Tasks stay prominent, then the
 * shortcuts the person pinned (or the context's defaults), then All modules; Settings and Help sit
 * apart at the bottom. Expanded (~240px, icons and labels) or collapsed (~72px, icons only);
 * collapsing gives the width back to the main content. Hidden below the `md` breakpoint, where the
 * bottom bar takes over.
 */
export function Sidebar({ initialState }: SidebarProps) {
  const t = useTranslations("Shell");
  const tNav = useTranslations("Nav");
  const pathname = usePathname();
  const [state, setState] = useState(initialState);
  const [tooltipHidden, setTooltipHidden] = useState(false);
  const collapsed = state === "collapsed";
  const shortcutsId = useId();

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
      className="inline-flex size-10 shrink-0 items-center justify-center rounded-pill text-fg-muted hover:bg-accent-subtle hover:text-fg"
    >
      {/* The arrow points towards the edge it moves to, so it mirrors in right-to-left layouts. */}
      <ToggleIcon className="rtl:-scale-x-100" />
    </button>
  );

  const homeId = homeIdFromPath(pathname);
  const { pinned } = useFavorites();
  const shortcuts = pinned
    .map((id) => moduleNav.find((item) => item.id === id))
    .filter((item): item is NavItem => item !== undefined);
  const modulesLink = modulesHref(homeId);
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
        "sticky top-0 hidden h-dvh shrink-0 md:flex",
        collapsed ? "p-2" : "p-4",
        "transition-[width] duration-(--md-duration-slow) ease-standard",
        collapsed ? "w-(--md-shell-sidebar-collapsed)" : "w-(--md-shell-sidebar-expanded)",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col rounded-card border border-line bg-sidebar shadow-raised">
        <div
          className={cx(
            "flex gap-2",
            collapsed ? "flex-col items-center px-1 py-3" : "items-center justify-between p-3",
          )}
        >
          <Brand label={t("brandLink")} showWordmark={!collapsed} />
          {toggleButton}
        </div>
        <nav
          aria-label={t("mainNavigation")}
          className={cx(
            "flex min-h-0 flex-1 flex-col justify-between gap-6 overflow-y-auto pt-1 pb-3",
            collapsed ? "px-1" : "px-3",
          )}
        >
          <div className="flex flex-col gap-4">
            {renderItems(coreNav)}
            {shortcuts.length > 0 ? (
              <section aria-labelledby={shortcutsId} className="flex flex-col gap-1">
                <h2
                  id={shortcutsId}
                  className={cx(
                    "px-3 text-helper font-semibold tracking-wide text-fg-muted uppercase",
                    collapsed && "sr-only",
                  )}
                >
                  {t("shortcuts")}
                </h2>
                {collapsed ? <hr aria-hidden="true" className="mx-3 border-line" /> : null}
                {renderItems(shortcuts)}
              </section>
            ) : null}
            <ul className="flex flex-col gap-1">
              <li>
                <NavLink
                  item={allModulesItem}
                  href={modulesLink}
                  label={t("allModules")}
                  active={isActive(modulesLink, pathname)}
                  collapsed={collapsed}
                  tooltipHidden={tooltipHidden}
                  onPointerEnter={showTooltips}
                  onFocus={showTooltips}
                />
              </li>
            </ul>
          </div>
          {renderItems(secondaryNav)}
        </nav>
      </div>
    </aside>
  );
}
