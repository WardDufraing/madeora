/** Ora's eight expressions (Ora design handoff). Client-safe. */
export const oraExpressions = [
  "idle",
  "curious",
  "happy",
  "cheer",
  "wave",
  "thinking",
  "surprised",
  "concerned",
] as const;
export type OraExpression = (typeof oraExpressions)[number];

/**
 * The three personal motion modes: gentle (floating, blinking and brief reactions, the default),
 * reactions only (no ambient motion) and none (static expressions with status text). The system's
 * reduced-motion setting always wins over the mode.
 */
export const oraMotionModes = ["gentle", "reactions", "none"] as const;
export type OraMotionMode = (typeof oraMotionModes)[number];
export const defaultOraMotion: OraMotionMode = "gentle";

export function isOraMotionMode(value: unknown): value is OraMotionMode {
  return typeof value === "string" && (oraMotionModes as readonly string[]).includes(value);
}

/** Whether the first-use introduction was finished or skipped; `null` while it has not been seen. */
export type OraIntroState = "completed" | "skipped" | null;

/** Brief reactions return to calm floating when they end; the others are held by the caller. */
export const briefReactionMilliseconds: Partial<Record<OraExpression, number>> = {
  cheer: 1700,
  wave: 1800,
  surprised: 1000,
  // A small reaction for an ordinary completion; no animation length is specified, so a short hold.
  happy: 2400,
};
