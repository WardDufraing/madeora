/**
 * Chore rotation (S20). Pure and framework-free. A rotating chore's schedule part numbers the dates
 * of its rule from where its rotation starts (`rotationFrom`): the first such date is turn 0, the
 * next turn 1, and so on. Every date of the rule counts, whether its occurrence was completed,
 * skipped, missed or never created because the chore was paused, so a skip, a miss or a pause never
 * shifts the order (spec "Confirmed missed rotating chore behavior", "Confirmed skipping recurring
 * chore occurrences"). Turn `n` goes to the participant at position `n` modulo the number of
 * places in the order.
 *
 * The database assigns occurrences with the same rule (`private.chore_turn` in
 * supabase/migrations/*_chores.sql); this module only previews it. `rotation-vectors.json` holds
 * cases both must answer alike (tests/db/rls/chore-rotation-vectors.test.ts).
 */
import {
  addDays,
  daysBetween,
  firstOnOrAfter,
  lastDate,
  type RecurrencePattern,
  type RecurrenceRule,
} from "../tasks/recurrence";

/** How many dates of the pattern lie on or after `rotationFrom` and before `date`. */
export function rotationTurn(
  pattern: RecurrencePattern,
  rotationFrom: string,
  date: string,
): number {
  const first = firstOnOrAfter(pattern, rotationFrom);
  if (date <= first) return 0;
  if (pattern.frequency === "daily") {
    return Math.ceil(daysBetween(first, date) / pattern.interval);
  }
  let turn = 0;
  let next = first;
  while (next < date) {
    turn += 1;
    next = firstOnOrAfter(pattern, addDays(next, 1));
  }
  return turn;
}

export interface RotationAssignment {
  readonly date: string;
  /** The place in the rotation order (0-based) whose turn the date is. */
  readonly position: number;
}

/**
 * Up to `limit` dates of the rule on or after `from` (within its end) with the place in the order
 * whose turn each one is. `places` is the number of places in the order (at least 1).
 */
export function rotationAssignments(
  rule: RecurrenceRule,
  rotationFrom: string,
  places: number,
  from: string,
  limit: number,
): RotationAssignment[] {
  if (!Number.isInteger(places) || places < 1) throw new RangeError("A rotation needs a place");
  const end = lastDate(rule);
  const result: RotationAssignment[] = [];
  let next = firstOnOrAfter(rule, from < rotationFrom ? rotationFrom : from);
  let turn = rotationTurn(rule, rotationFrom, next);
  while (result.length < limit && (end === null || next <= end)) {
    result.push({ date: next, position: turn % places });
    turn += 1;
    next = firstOnOrAfter(rule, addDays(next, 1));
  }
  return result;
}
