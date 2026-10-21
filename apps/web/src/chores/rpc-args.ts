import type { Json } from "@madeora/database";

import type { RecurrenceInput } from "@/tasks/schema";

import type { AssignmentInput, StepInput } from "./schema";

/** A recurrence rule as the chore functions take it (the S19 parameter names). */
export function ruleArgs(rule: RecurrenceInput) {
  return {
    p_frequency: rule.frequency,
    p_interval: rule.interval,
    p_starts_on: rule.startsOn,
    ...(rule.weekdays !== null ? { p_weekdays: rule.weekdays } : {}),
    ...(rule.endsOn !== null ? { p_ends_on: rule.endsOn } : {}),
    ...(rule.count !== null ? { p_max_count: rule.count } : {}),
  };
}

/** `private.chore_assignment`: `{ mode, members }` with membership ids in order. */
export function assignmentArg(assignment: AssignmentInput): Json {
  return { mode: assignment.mode, members: [...assignment.members] };
}

/** `private.chore_steps`: `[{ label, mandatory, id? }]` in order. */
export function stepsArg(steps: readonly (StepInput & { readonly id?: string | null })[]): Json {
  return steps.map((step) =>
    step.id
      ? { id: step.id, label: step.label, mandatory: step.mandatory }
      : {
          label: step.label,
          mandatory: step.mandatory,
        },
  );
}
