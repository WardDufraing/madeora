"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  recipeEndpoint,
  RecipeRequestError,
  sendRecipeRequest,
  type LockAcquired,
} from "@/recipes/api";

/** The heartbeat interval; the lock lasts 2 minutes after the last one (the database's limit). */
export const HEARTBEAT_MS = 30_000;
/** Without input for this long the editor warns, and after `INACTIVE_MS` it lets the lock lapse. */
export const WARN_AFTER_MS = 13 * 60_000;
export const INACTIVE_MS = 15 * 60_000;

export type LockState =
  | { readonly kind: "acquiring" }
  | { readonly kind: "held"; readonly revision: number }
  /**
   * Someone holds it: the person themselves elsewhere (`mine`), a member of the Home it is seen
   * from, or (member null) someone the person may not know (S25: an editor in another Home).
   */
  | { readonly kind: "locked"; readonly mine: boolean; readonly member: string | null }
  /** The lock ended (inactivity, a lost connection, or the person lost access). */
  | { readonly kind: "lapsed"; readonly reason: "inactive" | "lost" }
  | { readonly kind: "failed"; readonly failure: RecipeRequestError["failure"] };

/**
 * The exclusive editing lock of one published recipe for one editor session (S24): acquires it on
 * mount (or takes over the person's own lock on request), renews it every 30 s, warns after 13
 * minutes without input and lets it lapse at 15, and releases it when the page goes away. The
 * database decides every step; this only keeps it alive while someone is really editing.
 */
export function useRecipeLock(recipeId: string, homeId: string | null = null) {
  const [token] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<LockState>({ kind: "acquiring" });
  const [warning, setWarning] = useState(false);
  const lastInput = useRef(0);
  const held = state.kind === "held";

  const acquire = useCallback(
    async (takeOver: boolean) => {
      setState({ kind: "acquiring" });
      setWarning(false);
      lastInput.current = Date.now();
      try {
        const answer = await sendRecipeRequest<LockAcquired>(
          "POST",
          recipeEndpoint(recipeId, "lock"),
          { token, takeOver, ...(homeId ? { homeId } : {}) },
        );
        setState({ kind: "held", revision: answer.revision });
      } catch (error) {
        const failure =
          error instanceof RecipeRequestError ? error : new RecipeRequestError("failed");
        setState(
          failure.failure === "locked" && failure.holder
            ? { kind: "locked", mine: failure.holder.mine, member: failure.holder.member }
            : { kind: "failed", failure: failure.failure },
        );
      }
    },
    [recipeId, token, homeId],
  );

  const release = useCallback(
    (keepalive = false) =>
      sendRecipeRequest("DELETE", recipeEndpoint(recipeId, "lock"), { token }, { keepalive }).catch(
        () => undefined,
      ),
    [recipeId, token],
  );

  useEffect(() => {
    // Acquiring is the effect's purpose: the editor opens with a request for the lock.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void acquire(false);
  }, [acquire]);

  // Heartbeat and inactivity while held.
  useEffect(() => {
    if (!held) return;
    const beat = window.setInterval(() => {
      const idle = Date.now() - lastInput.current;
      if (idle >= INACTIVE_MS) {
        setState({ kind: "lapsed", reason: "inactive" });
        void release();
        return;
      }
      void sendRecipeRequest("PATCH", recipeEndpoint(recipeId, "lock"), { token }).catch(
        (error: unknown) => {
          if (error instanceof RecipeRequestError && error.failure === "lockLost") {
            setState({ kind: "lapsed", reason: "lost" });
          }
        },
      );
    }, HEARTBEAT_MS);
    const watch = window.setInterval(() => {
      const idle = Date.now() - lastInput.current;
      setWarning(idle >= WARN_AFTER_MS && idle < INACTIVE_MS);
      if (idle >= INACTIVE_MS) {
        setState({ kind: "lapsed", reason: "inactive" });
        void release();
      }
    }, 15_000);
    return () => {
      window.clearInterval(beat);
      window.clearInterval(watch);
    };
  }, [held, recipeId, release, token]);

  // Any input on the page counts as activity: it keeps the inactivity timer from running out.
  useEffect(() => {
    if (!held) return;
    const active = () => {
      lastInput.current = Date.now();
    };
    const events = ["keydown", "pointerdown", "input"] as const;
    for (const event of events) window.addEventListener(event, active, { passive: true });
    return () => {
      for (const event of events) window.removeEventListener(event, active);
    };
  }, [held]);

  // Leaving the page releases the lock at once (best effort; otherwise it lapses in 2 minutes).
  useEffect(() => {
    if (!held) return;
    const leave = () => {
      void release(true);
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
    };
  }, [held, release]);

  const touch = useCallback(() => {
    lastInput.current = Date.now();
    setWarning(false);
  }, []);

  const lose = useCallback(() => {
    setState({ kind: "lapsed", reason: "lost" });
  }, []);

  return { token, state, warning, acquire, release, touch, lose };
}
