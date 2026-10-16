"use client";

import type { ReactNode } from "react";

import { useHydrated } from "@/components/ui/use-hydrated";

/**
 * Keeps every control inside disabled until React has hydrated the page. Before that, a click on a
 * button would do nothing and a checkbox would change on screen without sending anything; a
 * disabled control says honestly that it is not ready yet. `display: contents` keeps the layout;
 * the fieldset is presentational, not a group of its own.
 */
export function HydrationGate({ children }: { readonly children: ReactNode }) {
  const hydrated = useHydrated();
  return (
    <fieldset role="presentation" disabled={!hydrated} className="contents">
      {children}
    </fieldset>
  );
}
