"use client";

import { MoreVerticalIcon } from "@madeora/icons";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { cx } from "./cx";

export interface OverflowMenuItem {
  /** Stable key; never a display name. */
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly icon?: ReactNode;
  /** Danger styling for removals. The label still says what it does. */
  readonly destructive?: boolean;
  readonly disabled?: boolean;
}

export interface OverflowMenuProps {
  /** Accessible name of the three-dot button, e.g. "Widget actions: Tasks" (translated by the caller). */
  readonly label: string;
  readonly items: readonly OverflowMenuItem[];
  readonly align?: "start" | "end";
  readonly className?: string;
}

/**
 * The three-dot actions menu used by widget headers and rows (redesign decision 20). The button
 * opens a `menu`: Arrow keys, Home and End move between enabled items, Enter or Space selects,
 * Escape and Tab close it, and focus returns to the button after a selection or Escape.
 */
export function OverflowMenu({ label, items, align = "end", className }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  function enabledItems(): HTMLButtonElement[] {
    return Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );
  }

  useEffect(() => {
    if (!open) return;
    enabledItems()[0]?.focus();
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const list = enabledItems();
    if (list.length === 0) return;
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    switch (event.key) {
      case "ArrowDown":
        next = list[(index + 1) % list.length];
        break;
      case "ArrowUp":
        next = list[(index - 1 + list.length) % list.length];
        break;
      case "Home":
        next = list[0];
        break;
      case "End":
        next = list[list.length - 1];
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      case "Tab":
        close(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    next?.focus();
  }

  return (
    <div ref={root} className={cx("relative inline-block", className)}>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => {
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="press-feedback inline-flex size-10 items-center justify-center rounded-control text-fg-muted hover:bg-accent-subtle hover:text-fg"
      >
        <MoreVerticalIcon />
      </button>
      {open ? (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          tabIndex={-1}
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className={cx(
            "absolute top-full z-40 mt-1 flex min-w-48 max-w-[calc(100vw-2rem)] animate-enter flex-col gap-0.5 rounded-card border border-line bg-surface-elevated p-1.5 text-fg shadow-overlay",
            align === "end" ? "end-0" : "start-0",
          )}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
              className={cx(
                "flex min-h-10 items-center gap-2 rounded-control px-3 text-start text-body hover:bg-accent-subtle focus-visible:bg-accent-subtle disabled:cursor-not-allowed disabled:opacity-60",
                item.destructive ? "text-danger" : "text-fg",
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
