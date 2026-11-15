import type { OraCelebration, OraCelebrationResponse } from "./types";

/** Asks whether Ora has a celebration for the person in this Home right now (S47c). */
export async function claimCelebration(
  homeId: string,
): Promise<{ readonly celebration: OraCelebration | null; readonly deferred: boolean }> {
  try {
    const response = await fetch("/api/v1/ora/celebrations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ homeId }),
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) return { celebration: null, deferred: false };
    const body = (await response
      .json()
      .catch(() => null)) as Partial<OraCelebrationResponse> | null;
    return { celebration: body?.celebration ?? null, deferred: body?.deferred === true };
  } catch {
    return { celebration: null, deferred: false };
  }
}
