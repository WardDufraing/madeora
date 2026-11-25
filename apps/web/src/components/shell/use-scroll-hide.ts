"use client";

import { useEffect, useState } from "react";

/** Near the top of the page the bar is always shown. */
const TOP_ZONE = 24;
/** Scrolling down this far in one direction hides the bar. */
const HIDE_AFTER = 32;
/** Scrolling up this far in one direction shows it again. */
const SHOW_AFTER = 12;
/** The bar stays put while the page is shorter than this beyond the first screen. */
const MIN_HIDE_OFFSET = 96;

/**
 * The next hidden state after a scroll, with hysteresis (redesign decision 27): small movements,
 * elastic overscroll and direction flips do nothing; only a deliberate run in one direction does.
 * Pure, so the rules are tested without a browser.
 */
export function nextScrollState(
  state: { hidden: boolean; anchor: number },
  y: number,
): { hidden: boolean; anchor: number } {
  const position = Math.max(0, y);
  if (position <= TOP_ZONE) return { hidden: false, anchor: position };
  const travel = position - state.anchor;
  if (state.hidden) {
    if (travel <= -SHOW_AFTER) return { hidden: false, anchor: position };
    // Keep the anchor on the lowest point reached, so the next upward run is measured from it.
    return { hidden: true, anchor: Math.max(state.anchor, position) };
  }
  if (travel >= HIDE_AFTER && position > MIN_HIDE_OFFSET) return { hidden: true, anchor: position };
  // Keep the anchor on the highest point reached while shown, so a downward run is measured from it.
  return { hidden: false, anchor: Math.min(state.anchor, position) };
}

/**
 * Whether the small-screen bottom bar should be hidden: after scrolling down, until the person
 * scrolls up. `paused` keeps it shown (a menu is open, or focus is inside it). Always shown at the
 * top of the page.
 */
export function useScrollHide(paused: boolean): boolean {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let state = { hidden: false, anchor: window.scrollY };
    function onScroll() {
      state = nextScrollState(state, window.scrollY);
      setHidden(state.hidden);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return hidden && !paused;
}
