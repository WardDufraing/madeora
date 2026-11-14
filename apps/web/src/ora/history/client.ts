import type { OraHistoryEntry, OraHistoryResponse, RecordHistoryInput } from "./types";

/** The browser's callers for Ora's seven-day history (S47b). */

export class OraHistoryError extends Error {
  constructor() {
    super("Ora history call failed");
    this.name = "OraHistoryError";
  }
}

export async function fetchHistory(homeId: string | null): Promise<readonly OraHistoryEntry[]> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/ora/history${homeId === null ? "" : `?homeId=${encodeURIComponent(homeId)}`}`,
      { credentials: "same-origin", cache: "no-store" },
    );
  } catch {
    throw new OraHistoryError();
  }
  if (!response.ok) throw new OraHistoryError();
  const body = (await response.json().catch(() => null)) as Partial<OraHistoryResponse> | null;
  if (!Array.isArray(body?.entries)) throw new OraHistoryError();
  return body.entries as readonly OraHistoryEntry[];
}

async function send(method: "POST" | "DELETE", body: unknown): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/v1/ora/history", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new OraHistoryError();
  }
  if (!response.ok) throw new OraHistoryError();
}

/** Records one line; a history line is a courtesy, so callers ignore a failure. */
export const recordHistory = (input: RecordHistoryInput): Promise<void> => send("POST", input);

/** Clears every history line of the person. */
export const clearHistory = (): Promise<void> => send("DELETE", {});
