/**
 * Personal timezone (spec, "Confirmed personal timezone detection and Home scheduling timezone").
 *
 * Automatic mode uses the zone this device reports; the browser keeps it in a first-party cookie
 * so the server renders times in it from the first paint. A zone the person chooses is stored on
 * the account and wins on every device. Before a device has reported its zone, UTC is used and the
 * settings page says so. Changing the zone only changes how times are shown; it never rewrites
 * stored instants. Home scheduling timezones are separate and arrive with Homes.
 */

export const TIMEZONE_COOKIE = "md-timezone";

/** Used, and labelled as such, until this device has reported its zone. */
export const FALLBACK_TIME_ZONE = "UTC";

// IANA names only ("Europe/Brussels", "America/Argentina/Buenos_Aires", "UTC"); no UTC offsets.
// Kept in step with the database's check constraint on user_preferences.timezone.
const zoneShape = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

/**
 * The zone with its usual capitals (`europe/brussels` → `Europe/Brussels`), or `null` when it is
 * not an IANA timezone this runtime knows. Otherwise the spelling is kept as given: browsers and
 * Node.js disagree on which name is canonical (`Europe/Kyiv` or `Europe/Kiev`), and both work.
 */
export function normalizeTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64 || !zoneShape.test(value)) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (!zoneShape.test(resolved)) return null;
  return resolved.toLowerCase() === value.toLowerCase() ? resolved : value;
}

export type TimeZoneSource = "chosen" | "device" | "fallback";

export interface EffectiveTimeZone {
  readonly timeZone: string;
  readonly source: TimeZoneSource;
}

/** The chosen zone, else this device's zone, else UTC. Invalid values are ignored. */
export function resolveTimeZone(input: {
  readonly chosen: string | null;
  readonly device: string | null | undefined;
}): EffectiveTimeZone {
  const chosen = normalizeTimeZone(input.chosen);
  if (chosen) return { timeZone: chosen, source: "chosen" };
  const device = normalizeTimeZone(input.device);
  if (device) return { timeZone: device, source: "device" };
  return { timeZone: FALLBACK_TIME_ZONE, source: "fallback" };
}

/**
 * Zones to offer in the timezone list: every zone this runtime knows, plus UTC and the given
 * extras (the saved and detected zones, which may be spelled differently), sorted and unique.
 */
export function timeZoneChoices(extras: readonly (string | null | undefined)[]): string[] {
  const zones = new Set<string>(Intl.supportedValuesOf("timeZone"));
  zones.add(FALLBACK_TIME_ZONE);
  for (const extra of extras) {
    const zone = normalizeTimeZone(extra);
    if (zone) zones.add(zone);
  }
  return [...zones].sort((a, b) => a.localeCompare(b, "en"));
}
