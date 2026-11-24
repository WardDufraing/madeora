"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { cx } from "./cx";

export interface PopoverProps {
  /** Accessible name of both the trigger button and the panel (translated by the caller). */
  readonly label: string;
  /** What the trigger button shows: text and/or a decorative icon. */
  readonly trigger: ReactNode;
  /** Which edge of the trigger the panel lines up with (logical, so it follows RTL). */
  readonly align?: "start" | "end";
  /** Panel content. A function receives `close`, for content that closes itself. */
  readonly children: ReactNode | ((close: () => void) => ReactNode);
  readonly triggerClassName?: string;
  readonly panelClassName?: string;
}

/**
 * A small non-modal panel anchored to a button, for quick settings and pickers. The trigger
 * reports `aria-expanded`; focus moves into the panel when it opens; Escape, a click outside or
 * tabbing out closes it and Escape returns focus to the trigger. It is not for content that
 * needs the rest of the page blocked: use a dialog for that.
 */
export function Popover({
  label,
  trigger,
  align = "start",
  children,
  triggerClassName,
  panelClassName,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const triggerId = useId();

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) document.getElementById(triggerId)?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(
      'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])',
    );
    (first ?? panel)?.focus();

    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div
      ref={root}
      role="presentation"
      className="relative inline-block"
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.stopPropagation();
          close(true);
        }
      }}
      onBlur={(event) => {
        // Tabbing out of the whole popover closes it without stealing focus back.
        if (
          open &&
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          close(false);
        }
      }}
    >
      <button
        id={triggerId}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className={cx(
          "press-feedback inline-flex min-h-10 items-center justify-center gap-2 rounded-control px-3 text-body text-fg hover:bg-accent-subtle",
          triggerClassName,
        )}
      >
        {trigger}
      </button>
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          className={cx(
            "absolute top-full z-40 mt-2 min-w-56 max-w-[calc(100vw-2rem)] animate-enter rounded-card border border-line bg-surface-elevated p-3 text-fg shadow-overlay",
            align === "end" ? "end-0" : "start-0",
            panelClassName,
          )}
        >
          {typeof children === "function"
            ? children(() => {
                close(true);
              })
            : children}
        </div>
      ) : null}
    </div>
  );
}
