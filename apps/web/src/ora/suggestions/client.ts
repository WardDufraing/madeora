import type {
  DismissSuggestionInput,
  OraSuggestion,
  OraSuggestionsResponse,
  OraTeaserResponse,
} from "./types";

/** The browser's callers for Ora's suggestions and daily teaser (S47). */

export class OraSuggestionError extends Error {
  constructor() {
    super("Ora suggestions call failed");
    this.name = "OraSuggestionError";
  }
}

const homeQuery = (homeId: string | null) =>
  homeId === null ? "" : `?homeId=${encodeURIComponent(homeId)}`;

export async function fetchSuggestions(homeId: string | null): Promise<readonly OraSuggestion[]> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/ora/suggestions${homeQuery(homeId)}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new OraSuggestionError();
  }
  if (!response.ok) throw new OraSuggestionError();
  const body = (await response.json().catch(() => null)) as Partial<OraSuggestionsResponse> | null;
  if (!Array.isArray(body?.suggestions)) throw new OraSuggestionError();
  return body.suggestions as readonly OraSuggestion[];
}

export async function dismissSuggestion(input: DismissSuggestionInput): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/v1/ora/suggestions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new OraSuggestionError();
  }
  if (!response.ok) throw new OraSuggestionError();
}

/** Asks for today's teaser: the suggestion to show unprompted, or `null` (muted, shown, nothing to say). */
export async function claimTeaser(
  homeId: string | null,
): Promise<{ readonly teaser: OraSuggestion | null; readonly deferred: boolean }> {
  try {
    const response = await fetch("/api/v1/ora/teaser", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ homeId }),
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) return { teaser: null, deferred: false };
    const body = (await response.json().catch(() => null)) as Partial<OraTeaserResponse> | null;
    return { teaser: body?.teaser ?? null, deferred: body?.deferred === true };
  } catch {
    return { teaser: null, deferred: false };
  }
}
