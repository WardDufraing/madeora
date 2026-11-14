import { z } from "zod";

/**
 * Ora's contextual suggestions (S47; spec "Confirmed Ora smart suppression of dismissed
 * suggestions", "minimal suggestion explanations"). Client-safe shapes. A suggestion is a short
 * offer that opens something Ora already does; it never changes data by itself.
 */

/** The suggestion kinds that exist. Each has its own message keys in `Ora.suggestions.<kind>`. */
export const suggestionKinds = ["today-overview"] as const;
export type SuggestionKind = (typeof suggestionKinds)[number];

export interface OraSuggestion {
  readonly kind: SuggestionKind;
  /**
   * What the suggestion is about (for an overview: the local date). A dismissal covers one
   * situation; a different one (tomorrow) may be offered again.
   */
  readonly situation: string;
  /** How many items the suggestion is about (open things today). */
  readonly count: number;
}

export const dismissSuggestionSchema = z.strictObject({
  homeId: z.uuid().nullable(),
  kind: z.enum(suggestionKinds),
  situation: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type DismissSuggestionInput = z.output<typeof dismissSuggestionSchema>;

/** `GET /api/v1/ora/suggestions?homeId` */
export interface OraSuggestionsResponse {
  readonly suggestions: readonly OraSuggestion[];
}

/** `POST /api/v1/ora/teaser`: the suggestion to show unprompted, or none (muted, already shown today, nothing to say). */
export interface OraTeaserResponse {
  readonly teaser: OraSuggestion | null;
  /** Held back for the person's quiet hours; ask again later (nothing was used up). */
  readonly deferred?: true;
}
