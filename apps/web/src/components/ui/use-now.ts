"use client";

import { useSyncExternalStore } from "react";

const MINUTE_MS = 60_000;

function subscribe(onChange: () => void): () => void {
  const timer = setInterval(onChange, MINUTE_MS);
  return () => {
    clearInterval(timer);
  };
}

// Rounded to the minute, so React sees the same value until the minute changes.
const minuteNow = () => Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;

/**
 * The current time to the minute, updated every minute, or `null` in the server render and
 * before hydration, so the server and the first browser render agree. For "valid until" previews.
 */
export function useNow(): number | null {
  return useSyncExternalStore(subscribe, minuteNow, () => null);
}
