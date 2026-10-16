"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A one-time notice that takes the keyboard focus when it appears, so after deleting a task the
 * person lands on the explanation instead of the top of a new page (S17 review M3).
 */
export function TaskNotice({ children }: { readonly children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="status"
      className="mb-4 rounded-control border border-line bg-surface p-3 text-body text-fg outline-none"
      data-testid="task-notice"
    >
      {children}
    </div>
  );
}
