"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { DashboardRequestError, saveDraft } from "@/dashboard/api";
import type { DashboardLayout } from "@/dashboard/layout";
import type { DashboardTarget } from "@/dashboard/schema";

/**
 * Where the edit-mode draft stands (redesign decision 6): never "saved" before the server says so.
 * - `idle`: nothing changed since edit mode opened, so there is nothing to keep.
 * - `unsaved`: a change waits for the next autosave.
 * - `saving`: an autosave is on its way.
 * - `saved`: the server holds exactly what is on screen.
 * - `failed`: the last autosave failed; the next change, or Try again, retries.
 * - `local`: this person cannot keep a server draft (children and Household Display accounts, or
 *   the right to edit was lost); changes live only on this screen until Done.
 */
export type DraftStatus = "idle" | "unsaved" | "saving" | "saved" | "failed" | "local";

/** Reads a flag that other callbacks set while an `await` was pending. */
function isSet(flag: { readonly current: boolean }): boolean {
  return flag.current;
}

/** Wait after the last change before an autosave, so a drag or a run of key presses is one save. */
export const AUTOSAVE_DELAY_MS = 800;

export interface DraftAutosave {
  readonly status: DraftStatus;
  /** Whether everything on screen is safe on the server (or nothing changed). */
  readonly persisted: boolean;
  /** Retries a failed autosave now. */
  readonly retry: () => void;
  /**
   * Stops autosaving and waits for an autosave already on its way, so nothing lands after Done,
   * Cancel or a reset. `resume` undoes it (a Done that failed keeps the draft going).
   */
  readonly stop: () => Promise<void>;
  readonly resume: () => void;
}

/**
 * Autosaves `layout` as the person's draft of `target` while it differs from where edit mode began.
 * One request at a time: a change made while one is on its way is sent right after it, so the
 * server always ends with the latest arrangement.
 */
export function useDraftAutosave({
  target,
  layout,
  baseRevision,
  startedSaved,
  localOnly = false,
}: {
  readonly target: DashboardTarget;
  readonly layout: DashboardLayout;
  /** The committed revision the draft builds on (changes when the person keeps their draft). */
  readonly baseRevision: number;
  /** Edit mode resumed a draft the server already holds. */
  readonly startedSaved: boolean;
  /**
   * Keep no server draft this session: the check for an earlier draft failed, so an autosave could
   * silently replace a draft the person never saw.
   */
  readonly localOnly?: boolean;
}): DraftAutosave {
  const [status, setStatus] = useState<DraftStatus>(startedSaved ? "saved" : "idle");
  const latest = useRef({ layout, baseRevision, target });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const stopped = useRef(false);
  const local = useRef(localOnly);
  // Where edit mode began: not a change (also when development StrictMode re-runs effects).
  const start = useRef({ layout, baseRevision });
  const touched = useRef(false);
  // A change that no autosave has picked up yet.
  const changed = useRef(false);
  const lastSent = useRef<{ layout: DashboardLayout; baseRevision: number } | null>(null);

  // Declared first, so the scheduling effect below always sees the current values.
  useEffect(() => {
    latest.current = { layout, baseRevision, target };
  }, [layout, baseRevision, target]);

  /** Sends the latest draft; a change made meanwhile is sent right after, in the same run. */
  const send = useCallback((): Promise<void> => {
    if (stopped.current || local.current) return Promise.resolve();
    if (inFlight.current) {
      again.current = true;
      return inFlight.current;
    }
    const run = async () => {
      do {
        again.current = false;
        const { layout: current, baseRevision: base, target: where } = latest.current;
        changed.current = false;
        setStatus("saving");
        try {
          await saveDraft(where, current, base);
          lastSent.current = { layout: current, baseRevision: base };
          // Changed while the request was on its way (the refs are written by other callbacks).
          const moreToSend = isSet(changed) || isSet(again);
          if (!stopped.current) setStatus(moreToSend ? "unsaved" : "saved");
        } catch (error) {
          if (error instanceof DashboardRequestError && error.failure === "notPermitted") {
            // No server draft for this person: say so instead of claiming anything is stored.
            local.current = true;
            setStatus("local");
            return;
          }
          changed.current = true;
          if (!stopped.current) setStatus("failed");
          return;
        }
      } while (isSet(again) && !stopped.current);
    };
    const request = run().finally(() => {
      inFlight.current = null;
    });
    inFlight.current = request;
    return request;
  }, []);

  useEffect(() => {
    // The layout edit mode opened with is not a change.
    if (
      !touched.current &&
      layout === start.current.layout &&
      baseRevision === start.current.baseRevision
    ) {
      return;
    }
    touched.current = true;
    const sent = lastSent.current;
    if (sent && sent.layout === layout && sent.baseRevision === baseRevision) return;
    if (local.current) {
      setStatus("local");
      return;
    }
    changed.current = true;
    setStatus("unsaved");
    // Paused (Done, a reset or a template on its way): `resume` sends it if that fails.
    if (stopped.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void send();
    }, AUTOSAVE_DELAY_MS);
  }, [layout, baseRevision, send]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const stop = useCallback(async () => {
    stopped.current = true;
    again.current = false;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inFlight.current) await inFlight.current;
  }, []);

  const resume = useCallback(() => {
    stopped.current = false;
    if (changed.current) void send();
  }, [send]);

  const retry = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    void send();
  }, [send]);

  return {
    status,
    persisted: status === "idle" || status === "saved",
    retry,
    stop,
    resume,
  };
}
