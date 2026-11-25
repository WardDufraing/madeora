"use client";

import { CloseIcon } from "@madeora/icons";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * The task side panel (redesign decision 48): a column beside the list on large screens, a bottom
 * sheet on narrow ones. It is not modal on desktop, so the list stays usable and another task can be
 * picked; on a narrow screen it covers the list, with a backdrop that closes it. The task itself is
 * rendered by the server (the same sections as the task page) and passed in. Closing is a link to
 * the page without `task`, so the view, filters and list stay as they were. Escape closes it, focus
 * moves to the task's title when it opens and returns to the task's row when it closes.
 */
export function TaskPanel({
  taskId,
  closeHref,
  closeLabel,
  label,
  children,
}: {
  readonly taskId: string;
  readonly closeHref: string;
  readonly closeLabel: string;
  /** Names the region when the task's own title is not available (it failed to load). */
  readonly label: string;
  readonly children: ReactNode;
}) {
  const router = useRouter();
  const ref = useRef<HTMLElement>(null);

  // Focus: into the panel when a task opens (or another is picked), back to its row on close.
  useEffect(() => {
    const heading = ref.current?.querySelector<HTMLElement>("#task-panel-title");
    (heading ?? ref.current)?.focus({ preventScroll: true });
  }, [taskId]);
  useEffect(() => {
    const panel = ref.current;
    return () => {
      // Only when the focus is still in the panel (or nowhere): never pull it away from elsewhere.
      const active = document.activeElement;
      if (active && active !== document.body && !panel?.contains(active)) return;
      document.querySelector<HTMLElement>(`[data-task-id="${taskId}"] a`)?.focus({
        preventScroll: true,
      });
    };
  }, [taskId]);

  // Escape closes the panel, except inside a dialog opened from it (that dialog closes first).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Element) {
        if (target.closest("dialog[open]")) return;
        // Escape in a field (a comment, a subtask, an inline "Add a task") must not drop the draft.
        if (target.closest("input, textarea, select, [contenteditable]")) return;
        // Escape elsewhere on the page belongs to that part of the page, not to the panel.
        if (
          target !== document.body &&
          !ref.current?.contains(target) &&
          !target.closest("[data-task-id]")
        )
          return;
      }
      router.push(closeHref, { scroll: false });
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [router, closeHref]);

  return (
    <>
      <div
        aria-hidden="true"
        className="fixed inset-0 z-30 bg-overlay lg:hidden"
        onClick={() => {
          router.push(closeHref, { scroll: false });
        }}
      />
      <aside
        ref={ref}
        tabIndex={-1}
        aria-label={label}
        data-testid="task-panel"
        className="fixed inset-x-0 bottom-0 z-40 max-h-[85dvh] overflow-y-auto rounded-t-overlay border border-line bg-surface-elevated p-panel-padding text-fg shadow-overlay outline-none motion-safe:animate-slide-up lg:sticky lg:inset-x-auto lg:top-4 lg:z-auto lg:max-h-[calc(100dvh-2rem)] lg:w-[28rem] lg:shrink-0 lg:rounded-overlay lg:shadow-raised"
      >
        <Link
          href={closeHref}
          scroll={false}
          aria-label={closeLabel}
          className="absolute end-3 top-3 inline-flex size-10 items-center justify-center rounded-control text-fg-muted hover:bg-accent-subtle hover:text-fg"
          data-testid="task-panel-close"
        >
          <CloseIcon />
        </Link>
        {children}
      </aside>
    </>
  );
}
