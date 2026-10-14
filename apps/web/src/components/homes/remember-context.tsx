"use client";

import { useEffect } from "react";

import {
  CONTEXT_COOKIE,
  formatRememberedContext,
  type RememberedContext,
} from "@/homes/context-cookie";
import { preferenceCookie } from "@/preferences/preferences";

export interface RememberContextProps {
  readonly userId: string;
  /** Rendered only after the server has confirmed the membership for a Home. */
  readonly context: RememberedContext;
  /** Removes these query parameters from the address once shown (one-time notices, `context`). */
  readonly clearParams?: readonly string[];
}

/**
 * Remembers on this device which context was shown last, so opening Madeora (`/`) returns to it
 * (spec: "Remember the last valid active Home as a convenience"). Renders nothing.
 */
export function RememberContext({ userId, context, clearParams = [] }: RememberContextProps) {
  const value = formatRememberedContext(userId, context);
  const params = clearParams.join(",");
  useEffect(() => {
    document.cookie = preferenceCookie(
      CONTEXT_COOKIE,
      value,
      window.location.protocol === "https:",
    );
    if (params === "") return;
    const url = new URL(window.location.href);
    let changed = false;
    for (const name of params.split(",")) {
      if (url.searchParams.has(name)) {
        url.searchParams.delete(name);
        changed = true;
      }
    }
    if (changed) window.history.replaceState(window.history.state, "", url);
  }, [value, params]);
  return null;
}
