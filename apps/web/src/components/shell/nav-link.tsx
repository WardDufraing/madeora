"use client";

import Link from "next/link";

import { cx } from "@/components/ui/cx";

import type { NavItem } from "./nav-items";

export interface NavLinkProps {
  readonly item: NavItem;
  readonly label: string;
  readonly active: boolean;
  /** Collapsed sidebar: icon only, with the label kept as the accessible name and a tooltip. */
  readonly collapsed?: boolean;
  /** Collapsed only: hides the tooltip after Escape until the pointer or focus moves on. */
  readonly tooltipHidden?: boolean;
  readonly onNavigate?: () => void;
  readonly onPointerEnter?: () => void;
  readonly onFocus?: () => void;
}

/** One navigation destination, used by the sidebar and the small-screen menu. */
export function NavLink({
  item,
  label,
  active,
  collapsed = false,
  tooltipHidden = false,
  onNavigate,
  onPointerEnter,
  onFocus,
}: NavLinkProps) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      {...(onNavigate ? { onClick: onNavigate } : {})}
      {...(onPointerEnter ? { onPointerEnter } : {})}
      {...(onFocus ? { onFocus } : {})}
      className={cx(
        "group relative flex h-10 items-center rounded-control text-body transition-colors duration-(--md-duration-fast)",
        "hover:bg-accent-subtle hover:text-fg",
        // The current page is marked by weight and a bar at the start edge, not by colour alone.
        active
          ? "bg-accent-subtle font-semibold text-fg before:absolute before:inset-y-2 before:start-0 before:w-1 before:rounded-full before:bg-accent forced-colors:before:bg-[Highlight] before:forced-color-adjust-none"
          : "text-fg-muted",
        collapsed ? "mx-auto w-10 justify-center" : "gap-3 px-3",
      )}
    >
      <Icon size="md" className="shrink-0" />
      {collapsed ? (
        <>
          <span className="sr-only">{label}</span>
          {/* The tooltip is a fixed-position box left at its static position, at the link's end
              edge, so the scrolling navigation never clips it and it mirrors in right-to-left
              layouts. It is inside the link, so the pointer can move onto it (WCAG 1.4.13). */}
          <span aria-hidden="true" className="absolute inset-y-0 end-0 flex items-center">
            <span
              className={cx(
                "invisible fixed z-30 ms-3 whitespace-nowrap rounded-control border border-line bg-surface-elevated px-2 py-1 text-helper font-normal text-fg shadow-overlay",
                !tooltipHidden && "group-hover:visible group-focus-visible:visible",
              )}
            >
              {label}
            </span>
          </span>
        </>
      ) : (
        <span className="truncate">{label}</span>
      )}
    </Link>
  );
}
