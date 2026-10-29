/**
 * Message keys of the preset units (S29), shared by the client hook and the server-rendered
 * notification centre. A custom unit has no key: it is shown as the person wrote it. Units that read
 * differently in the singular have two keys, chosen with the locale's plural rules.
 */
const unitKeys = {
  glasses: ["unitGlassOne", "unitGlassOther"],
  pages: ["unitPageOne", "unitPageOther"],
  repetitions: ["unitRepetitionOne", "unitRepetitionOther"],
  ml: ["unitMl", "unitMl"],
  l: ["unitL", "unitL"],
  min: ["unitMin", "unitMin"],
  h: ["unitH", "unitH"],
  m: ["unitM", "unitM"],
  km: ["unitKm", "unitKm"],
} as const;

export type PresetUnit = keyof typeof unitKeys;

export function isPresetUnit(unit: string): unit is PresetUnit {
  return Object.hasOwn(unitKeys, unit);
}

/** The message that names a preset unit for a quantity (1 glass, 1.5 glasses). */
export function unitMessageKey(unit: PresetUnit, count: number, locale: string) {
  const [one, other] = unitKeys[unit];
  return new Intl.PluralRules(locale).select(count) === "one" ? one : other;
}

/** Every unit message key (for the check that no message is unused). */
export const unitMessageKeys: readonly string[] = [...new Set(Object.values(unitKeys).flat())];
