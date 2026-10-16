"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A polite live region for results of actions. Saying the same words twice (two subtasks ticked
 * one after the other, the same error again) is announced twice: the region is emptied first and
 * refilled a moment later, which screen readers report as a new message (S17 review L5).
 */
export function useAnnouncer(): {
  readonly announce: (message: string) => void;
  readonly region: React.ReactElement;
} {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const announce = useCallback((next: string) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage("");
    timer.current = setTimeout(() => {
      setMessage(next);
    }, 60);
  }, []);

  const region = (
    <p className="sr-only" role="status" aria-live="polite" data-testid="live-region">
      {message}
    </p>
  );
  return { announce, region };
}
