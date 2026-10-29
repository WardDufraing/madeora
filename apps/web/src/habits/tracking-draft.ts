import {
  decimalSeparator,
  habitUnitInfo,
  HABIT_QUANTITY,
  parseQuantity,
  suggestedQuickAdds,
  thousandthsToDecimal,
  toThousandths,
  type HabitUnit,
  type HabitUnitKind,
  type QuantityProblem,
} from "@madeora/domain/habits";

import type { HabitTracking } from "./shapes";

/**
 * How a form holds a habit's tracking while it is edited (S29): everything is the text the person
 * typed, in their own locale, until `trackingFromDraft` reads it. Client-safe.
 */

export const CUSTOM_UNIT = "custom";

export interface TrackingDraft {
  readonly numeric: boolean;
  /** A preset unit code, or `CUSTOM_UNIT`. */
  readonly unit: string;
  readonly custom: string;
  readonly target: string;
  readonly quickAdds: readonly string[];
}

/** The body the API takes: decimal strings, never localized text. */
export interface TrackingBody {
  readonly target: string;
  readonly unit: string;
  readonly unitKind: HabitUnitKind;
  readonly quickAdds: readonly string[];
}

export interface TrackingErrors {
  readonly unit?: "required" | "tooLong";
  readonly target?: QuantityProblem;
  /** By position; "duplicate" marks the second of two equal presets. */
  readonly quickAdds: readonly (QuantityProblem | "duplicate" | undefined)[];
}

export type TrackingResult =
  | { readonly ok: true; readonly tracking: TrackingBody | null }
  | { readonly ok: false; readonly errors: TrackingErrors };

/** Thousandths as text a person of this locale types ("1,5" in Dutch, "1.5" in English). */
export function localizedDecimal(thousandths: number, locale: string): string {
  return thousandthsToDecimal(thousandths).replace(".", decimalSeparator(locale));
}

function presetsFor(unit: HabitUnit, locale: string): readonly string[] {
  return suggestedQuickAdds(unit).map((amount) => localizedDecimal(amount, locale));
}

export function defaultTrackingDraft(locale: string): TrackingDraft {
  return {
    numeric: false,
    unit: "glasses",
    custom: "",
    target: "",
    quickAdds: presetsFor({ unit: "glasses", kind: "preset" }, locale),
  };
}

/** The unit a draft names, or null while a custom label is empty or too long. */
export function draftUnit(draft: Pick<TrackingDraft, "unit" | "custom">): HabitUnit | null {
  const unit: HabitUnit =
    draft.unit === CUSTOM_UNIT
      ? { unit: draft.custom.trim(), kind: "custom" }
      : { unit: draft.unit, kind: "preset" };
  return habitUnitInfo(unit) === null ? null : unit;
}

/** A draft's unit changed: presets restart from the new unit's suggestions (never converted). */
export function withUnit(
  draft: TrackingDraft,
  unit: string,
  custom: string,
  locale: string,
): TrackingDraft {
  const next = { ...draft, unit, custom };
  const named = draftUnit(next);
  return { ...next, quickAdds: named ? presetsFor(named, locale) : [] };
}

export function draftFromTracking(tracking: HabitTracking, locale: string): TrackingDraft {
  if (tracking.mode !== "numeric" || tracking.unit === null || tracking.target === null) {
    return defaultTrackingDraft(locale);
  }
  const custom = tracking.unitKind === "custom";
  return {
    numeric: true,
    unit: custom ? CUSTOM_UNIT : tracking.unit,
    custom: custom ? tracking.unit : "",
    target: localizedDecimal(toThousandths(tracking.target), locale),
    quickAdds: tracking.quickAdds.map((amount) => localizedDecimal(toThousandths(amount), locale)),
  };
}

/** Reads a draft: the API body (null: complete once), or what is wrong at each field. */
export function trackingFromDraft(draft: TrackingDraft, locale: string): TrackingResult {
  if (!draft.numeric) return { ok: true, tracking: null };
  const unit = draftUnit(draft);
  const problems: {
    unit?: "required" | "tooLong";
    target?: QuantityProblem;
    quickAdds: (QuantityProblem | "duplicate" | undefined)[];
  } = { quickAdds: [] };
  if (unit === null) {
    problems.unit = draft.custom.trim() === "" ? "required" : "tooLong";
  }
  const target = parseQuantity(draft.target, locale, unit ?? undefined);
  if (!target.ok) problems.target = target.problem;
  const amounts: number[] = [];
  const seen = new Set<number>();
  const quickAdds: string[] = [];
  draft.quickAdds.forEach((text, index) => {
    if (text.trim() === "") {
      problems.quickAdds[index] = undefined;
      return;
    }
    const parsed = parseQuantity(text, locale, unit ?? undefined);
    if (!parsed.ok) {
      problems.quickAdds[index] = parsed.problem;
    } else if (seen.has(parsed.thousandths)) {
      problems.quickAdds[index] = "duplicate";
    } else {
      seen.add(parsed.thousandths);
      amounts.push(parsed.thousandths);
      quickAdds.push(thousandthsToDecimal(parsed.thousandths));
    }
  });
  if (
    unit === null ||
    !target.ok ||
    problems.quickAdds.some((problem) => problem !== undefined) ||
    amounts.length > HABIT_QUANTITY.quickAdds
  ) {
    return { ok: false, errors: problems };
  }
  return {
    ok: true,
    tracking: {
      target: thousandthsToDecimal(target.thousandths),
      unit: unit.unit,
      unitKind: unit.kind,
      quickAdds,
    },
  };
}
