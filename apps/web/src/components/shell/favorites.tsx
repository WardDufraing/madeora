"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { saveFavorites } from "@/preferences/client";

import { homeIdFromPath, resolveFavorites, type NavId } from "./nav-items";

interface FavoritesState {
  /** What the person pinned, or `null` while the context's default shortcuts apply. */
  readonly saved: readonly string[] | null;
  readonly setSaved: (next: readonly string[]) => void;
}

const FavoritesContext = createContext<FavoritesState | null>(null);

export interface FavoritesProviderProps {
  /** Read from the device cookie by the server, so the first paint matches the client. */
  readonly initial: readonly string[] | null;
  readonly children: ReactNode;
}

/**
 * Shares the pinned module shortcuts between the sidebar, the small-screen menu and All modules,
 * so pinning on one updates the others at once. A device preference: it holds no personal data
 * and is never used for access (every destination still checks the person's access itself).
 */
export function FavoritesProvider({ initial, children }: FavoritesProviderProps) {
  const [saved, setSavedState] = useState<readonly string[] | null>(initial);
  const setSaved = useCallback((next: readonly string[]) => {
    setSavedState(next);
    saveFavorites(next);
  }, []);
  const value = useMemo(() => ({ saved, setSaved }), [saved, setSaved]);
  return <FavoritesContext value={value}>{children}</FavoritesContext>;
}

export interface Favorites {
  readonly pinned: readonly NavId[];
  readonly isPinned: (id: NavId) => boolean;
  readonly toggle: (id: NavId) => void;
}

/** The shortcuts in the open context (Personal or a Home), and a way to pin or unpin one. */
export function useFavorites(): Favorites {
  const context = useContext(FavoritesContext);
  const homeId = homeIdFromPath(usePathname());
  const saved = context?.saved ?? null;
  const pinned = useMemo(() => resolveFavorites(saved, homeId), [saved, homeId]);
  const setSaved = context?.setSaved;
  const toggle = useCallback(
    (id: NavId) => {
      const next = pinned.includes(id) ? pinned.filter((item) => item !== id) : [...pinned, id];
      setSaved?.(next);
    },
    [pinned, setSaved],
  );
  return { pinned, isPinned: (id) => pinned.includes(id), toggle };
}
