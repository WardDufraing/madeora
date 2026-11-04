/** Paths and query keys of the pets pages (S31). Client-safe. */

export function petsPath(homeId: string): string {
  return `/homes/${homeId}/pets`;
}

export function petPath(homeId: string, petId: string): string {
  return `${petsPath(homeId)}/${petId}`;
}

export function medicalEntryPath(homeId: string, petId: string, entryId: string): string {
  return `${petPath(homeId, petId)}/medical/${entryId}`;
}

export function careActivityPath(homeId: string, petId: string, activityId: string): string {
  return `${petPath(homeId, petId)}/care/${activityId}`;
}

export const petKeys = {
  all: ["pets"] as const,
};

/**
 * A pet's age in whole years and months on `today` from a known birth date, or from an approximate
 * age recorded on a date (it keeps counting from then). Null when neither is known. Never a birthday.
 */
export function petAge(
  pet: {
    readonly birthDate: string | null;
    readonly ageYears: number | null;
    readonly ageMonths: number | null;
    readonly ageRecordedOn: string | null;
  },
  today: string,
): { readonly years: number; readonly months: number; readonly approximate: boolean } | null {
  const months = (from: string, base: number) => {
    const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
    const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
    const total = base + (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
    return Math.max(0, total);
  };
  let total: number;
  let approximate: boolean;
  if (pet.birthDate) {
    total = months(pet.birthDate, 0);
    approximate = false;
  } else if (pet.ageYears !== null && pet.ageRecordedOn) {
    total = months(pet.ageRecordedOn, pet.ageYears * 12 + (pet.ageMonths ?? 0));
    approximate = true;
  } else {
    return null;
  }
  return { years: Math.floor(total / 12), months: total % 12, approximate };
}

/** Decimal input as people type it in nl or en ("28,4" or "28.4"); null when it is not a number. */
export function parseDecimal(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,4}(?:[.,]\d{1,3})?$/u.test(trimmed)) return null;
  return Number(trimmed.replace(",", "."));
}
