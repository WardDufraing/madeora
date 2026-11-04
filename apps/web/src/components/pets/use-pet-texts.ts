"use client";

import { useLocale, useTranslations } from "next-intl";

import { formatHabitDate } from "@/habits/format";
import type { PetFailure } from "@/pets/api";
import { petAge } from "@/pets/format";
import type { PetCareCategory, PetCareFrequency, PetCareStatus } from "@/pets/care-schema";
import type { PetEventType, PetSpecies } from "@/pets/schema";
import type { PetUploadFailure } from "@/pets/upload";

const failureKey = {
  signedOut: "failureSignedOut",
  invalid: "failureInvalid",
  notFound: "failureNotFound",
  notPermitted: "failureNotPermitted",
  stale: "failureStale",
  idTaken: "failureFailed",
  limitReached: "failureLimitReached",
  closed: "failureClosed",
  invalidMember: "failureInvalidMember",
  invalidDates: "failureInvalidDates",
  invalidState: "failureInvalidState",
  network: "failureNetwork",
  failed: "failureFailed",
} as const satisfies Record<PetFailure, string>;

const uploadKey = {
  type: "uploadType",
  size: "uploadSize",
  limit: "uploadLimit",
  storageFull: "uploadStorageFull",
  storageOff: "uploadStorageOff",
  rateLimited: "uploadRateLimited",
  invalidFile: "uploadInvalidFile",
  expired: "uploadExpired",
  notPermitted: "failureNotPermitted",
  notFound: "failureNotFound",
  signedOut: "failureSignedOut",
  network: "failureNetwork",
  failed: "uploadFailed",
} as const satisfies Record<PetUploadFailure, string>;

const speciesKey = {
  dog: "speciesDog",
  cat: "speciesCat",
  rabbit: "speciesRabbit",
  guinea_pig: "speciesGuineaPig",
  hamster: "speciesHamster",
  bird: "speciesBird",
  fish: "speciesFish",
  reptile: "speciesReptile",
  horse: "speciesHorse",
  other: "speciesOther",
} as const satisfies Record<PetSpecies, string>;

const eventKey = {
  vet_visit: "eventVetVisit",
  vaccination: "eventVaccination",
  treatment: "eventTreatment",
  test: "eventTest",
  surgery: "eventSurgery",
  other: "eventOther",
} as const satisfies Record<PetEventType, string>;

const careCategoryKey = {
  feeding: "careFeeding",
  medication: "careMedication",
  grooming: "careGrooming",
  vet_appointment: "careVetAppointment",
  other: "careOther",
} as const satisfies Record<PetCareCategory, string>;

const careStatusKey = {
  upcoming: "statusUpcoming",
  due: "statusDue",
  overdue: "statusOverdue",
  completed: "statusCompleted",
  skipped: "statusSkipped",
  paused: "statusPaused",
} as const satisfies Record<PetCareStatus, string>;

const frequencyKey = {
  once: "frequencyOnce",
  daily: "frequencyDaily",
  weekly: "frequencyWeekly",
  monthly: "frequencyMonthly",
  yearly: "frequencyYearly",
} as const satisfies Record<PetCareFrequency, string>;

const fieldKey = {
  required: "errorRequired",
  tooLong: "errorTooLong",
  invalidCharacters: "errorInvalidCharacters",
  birthOrAge: "errorBirthOrAge",
  weightUnit: "errorWeightUnit",
  beforeEvent: "errorBeforeEvent",
  future: "errorFuture",
  outOfRange: "errorOutOfRange",
  beforeStart: "errorBeforeStart",
} as const;

/** The texts the pets views share: failures, labels and dates in the viewer's language. */
export function usePetTexts() {
  const t = useTranslations("Pets");
  const locale = useLocale();
  return {
    locale,
    failure: (failure: PetFailure) => t(failureKey[failure]),
    upload: (failure: PetUploadFailure) => t(uploadKey[failure]),
    species: (species: PetSpecies, label: string | null) =>
      species === "other" && label ? label : t(speciesKey[species]),
    eventType: (type: PetEventType) => t(eventKey[type]),
    careCategory: (category: PetCareCategory) => t(careCategoryKey[category]),
    careStatus: (status: PetCareStatus) => t(careStatusKey[status]),
    frequency: (frequency: PetCareFrequency) => t(frequencyKey[frequency]),
    /** An activity's name: its title, or its category when the title is concealed. */
    careTitle: (activity: { readonly title: string | null; readonly category: PetCareCategory }) =>
      activity.title ?? t(careCategoryKey[activity.category]),
    /** A field's validation message from a schema issue's message. */
    field: (message: string | undefined) =>
      message && message in fieldKey
        ? t(fieldKey[message as keyof typeof fieldKey])
        : t("errorInvalid"),
    date: (date: string) => formatHabitDate(date, locale, "long"),
    shortDate: (date: string) =>
      new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${date}T00:00:00Z`)),
    /** "3 years, 2 months", or "about 3 years" for an approximate age; null when unknown. */
    age: (pet: Parameters<typeof petAge>[0], today: string): string | null => {
      const age = petAge(pet, today);
      if (!age) return null;
      const text = t("ageValue", { years: age.years, months: age.months });
      return age.approximate ? t("ageAbout", { age: text }) : text;
    },
  };
}

export type PetTexts = ReturnType<typeof usePetTexts>;
