import { z } from "zod";

/**
 * Ora's achievement celebrations (S47c; spec "Confirmed Ora subtle animated achievement
 * celebrations"). Client-safe shapes. A celebration is a short, grouped acknowledgement of chore
 * points the person has really been awarded in a Home: the ledger entry exists, it was not
 * reversed, and it belongs to the person. Nothing about other members, balances or rankings.
 */

export interface OraCelebration {
  /** How many awards this note covers (several close together are grouped into one). */
  readonly count: number;
  /** The points awarded in total. */
  readonly points: number;
  /** The chore's name, only when exactly one award is covered. */
  readonly title: string | null;
}

export const celebrationBodySchema = z.strictObject({ homeId: z.uuid().nullable() });

/** `POST /api/v1/ora/celebrations`: the celebration to show now, or none. */
export interface OraCelebrationResponse {
  readonly celebration: OraCelebration | null;
  /** Held back for quiet hours or unreadable settings: ask again later (nothing was claimed). */
  readonly deferred?: true;
}

export const celebrationAnswerSchema = z.object({
  count: z.number().int().min(1).max(20),
  points: z.number().int().min(1),
  title: z.string().max(500).nullable(),
});
