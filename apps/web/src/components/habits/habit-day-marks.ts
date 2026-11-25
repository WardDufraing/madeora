import type { HabitDayState } from "@madeora/domain/habits";

/** A mark per state, so a state never depends on colour alone. */
export const stateMark: { readonly [S in HabitDayState]: string } = {
  completed: "\u{2713}",
  missed: "\u{2717}",
  paused: "\u{2016}",
  pending: "\u{25CB}",
  open: "\u{25CB}",
  not_scheduled: "\u{2013}",
  untracked: "\u{00B7}",
  future: "",
};

export const stateTone: { readonly [S in HabitDayState]: string } = {
  completed: "bg-accent-subtle text-fg font-semibold",
  missed: "text-danger",
  paused: "text-fg-muted",
  pending: "text-fg",
  open: "text-fg",
  not_scheduled: "text-fg-muted",
  untracked: "text-fg-muted",
  future: "text-fg-muted",
};
