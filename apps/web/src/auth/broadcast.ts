/**
 * Tells this browser's other Madeora tabs that the person signed out, so they drop cached data and
 * re-check access at once instead of on their next click (architecture.md §7: multi-tab sign-out).
 */
const CHANNEL = "madeora-auth";
const SIGNED_OUT = "signed-out";

export function announceSignedOut(): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage(SIGNED_OUT);
  channel.close();
}

/** Calls `onSignedOut` when another tab signs out. Returns the function that stops listening. */
export function onSignedOutElsewhere(onSignedOut: () => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent) => {
    if (event.data === SIGNED_OUT) onSignedOut();
  };
  return () => {
    channel.close();
  };
}
