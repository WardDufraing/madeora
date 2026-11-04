import type {
  CareActivity,
  CareActivityDetail,
  CareOccurrence,
  HomeCare,
  PetCare,
} from "./care-shapes";
import type {
  MedicalAccessList,
  MedicalEntry,
  MedicalEntryDetail,
  PetDetail,
  PetList,
  PetMedical,
} from "./shapes";

/** Test data for the pets routes and components (S31). Not imported by app code. */

export const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
export const PET = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a0";
export const ENTRY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a1";
export const ATTACHMENT = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a2";
export const FILE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a3";
export const MEMBERSHIP = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a4";

/** A cat with part of its profile, breed Unknown; the viewer manages pets and medical info. */
export function petDetail(overrides: Partial<PetDetail> = {}): PetDetail {
  return {
    id: PET,
    homeId: HOME,
    name: "Miso",
    species: "cat",
    speciesLabel: null,
    birthDate: "2022-03-15",
    ageYears: null,
    ageMonths: null,
    ageRecordedOn: null,
    photoFileId: null,
    breed: null,
    sex: "female",
    neutered: true,
    weight: 4.2,
    weightUnit: "kg",
    weightRecordedOn: "2026-10-01",
    vetName: null,
    vetClinic: "De Dierenkliniek",
    vetPhone: null,
    vetEmail: null,
    vetAddress: null,
    diet: null,
    careInstructions: null,
    notes: null,
    unknown: ["breed"],
    revision: 2,
    createdAt: "2026-11-01T09:00:00Z",
    updatedAt: "2026-11-02T09:00:00Z",
    access: "manage",
    medicalAccess: "manage",
    today: "2026-11-10",
    ...overrides,
  };
}

export function petList(overrides: Partial<PetList> = {}): PetList {
  const pet = petDetail();
  return {
    access: "manage",
    medicalAccess: "manage",
    limit: 50,
    pets: [
      {
        id: pet.id,
        name: pet.name,
        species: pet.species,
        speciesLabel: null,
        birthDate: pet.birthDate,
        ageYears: null,
        ageMonths: null,
        ageRecordedOn: null,
        photoFileId: null,
      },
    ],
    ...overrides,
  };
}

export function medicalEntry(overrides: Partial<MedicalEntry> = {}): MedicalEntry {
  return {
    id: ENTRY,
    petId: PET,
    type: "vaccination",
    date: "2026-10-20",
    title: "Rabies booster",
    veterinarian: null,
    location: null,
    treatment: null,
    notes: null,
    followUpDate: null,
    revision: 1,
    createdAt: "2026-10-20T09:00:00Z",
    updatedAt: "2026-10-20T09:00:00Z",
    attachments: [
      {
        id: ATTACHMENT,
        fileId: FILE,
        name: "certificate.pdf",
        contentType: "application/pdf",
        size: 120_000,
        addedAt: "2026-10-20T09:05:00Z",
      },
    ],
    ...overrides,
  };
}

export function medicalEntryDetail(
  overrides: Partial<MedicalEntryDetail> = {},
): MedicalEntryDetail {
  return {
    ...medicalEntry(),
    petName: "Miso",
    homeId: HOME,
    level: "manage",
    today: "2026-11-10",
    ...overrides,
  };
}

/** Allergies None, medications not entered; one past vaccination and one upcoming vet visit. */
export function petMedical(overrides: Partial<PetMedical> = {}): PetMedical {
  return {
    petId: PET,
    level: "manage",
    today: "2026-11-10",
    details: {
      allergies: null,
      medications: null,
      microchip: "981000000000001",
      registration: null,
      identificationNotes: null,
      medicalNotes: null,
      unknown: ["registration"],
      none: ["allergies"],
      revision: 1,
      updatedAt: "2026-11-02T09:00:00Z",
    },
    entries: [
      medicalEntry(),
      medicalEntry({
        id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00b1",
        type: "vet_visit",
        date: "2026-12-01",
        title: "Dental check",
        attachments: [],
      }),
    ],
    ...overrides,
  };
}

export function medicalAccessList(overrides: Partial<MedicalAccessList> = {}): MedicalAccessList {
  return {
    canGrant: true,
    members: [
      {
        membershipId: MEMBERSHIP,
        isSelf: false,
        role: "member",
        level: "none",
        canChange: true,
      },
    ],
    ...overrides,
  };
}

export const ACTIVITY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00b0";
export const OCCURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00b1";
export const OTHER_MEMBERSHIP = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00b2";

/** One open care occurrence due today (S31 care part). */
export function careOccurrence(overrides: Partial<CareOccurrence> = {}): CareOccurrence {
  return {
    id: OCCURRENCE,
    activityId: ACTIVITY,
    scheduledOn: "2026-11-04",
    dueOn: "2026-11-04",
    time: "07:30",
    status: "due",
    detached: false,
    revision: 1,
    members: [MEMBERSHIP],
    mine: true,
    completedAt: null,
    completedBy: null,
    recordedByMe: false,
    note: null,
    skippedAt: null,
    skippedBy: null,
    corrected: false,
    ...overrides,
  };
}

/** A daily feeding activity whose next occurrence is due today. */
export function careActivity(overrides: Partial<CareActivity> = {}): CareActivity {
  return {
    id: ACTIVITY,
    petId: PET,
    title: "Breakfast",
    category: "feeding",
    instructions: "Half a cup",
    medical: false,
    concealed: false,
    reminder: 15,
    state: "active",
    revision: 1,
    canEdit: true,
    canManage: true,
    schedule: {
      frequency: "daily",
      interval: 1,
      weekdays: null,
      startsOn: "2026-11-01",
      endsOn: null,
      time: "07:30",
      members: [MEMBERSHIP],
    },
    next: careOccurrence(),
    overdue: 0,
    ...overrides,
  };
}

export function petCare(overrides: Partial<PetCare> = {}): PetCare {
  return {
    petId: PET,
    today: "2026-11-04",
    canManage: true,
    canManageMedical: true,
    activities: [careActivity()],
    ...overrides,
  };
}

export function careActivityDetail(
  overrides: Partial<CareActivityDetail> = {},
): CareActivityDetail {
  return {
    ...careActivity(),
    homeId: HOME,
    timeZone: "Europe/Amsterdam",
    today: "2026-11-04",
    open: [careOccurrence()],
    recent: [],
    ...overrides,
  };
}

export function homeCare(overrides: Partial<HomeCare> = {}): HomeCare {
  return {
    today: "2026-11-04",
    rows: [
      {
        ...careOccurrence(),
        petId: PET,
        petName: "Miso",
        activity: { title: "Breakfast", category: "feeding", medical: false, concealed: false },
      },
    ],
    hasMore: false,
    ...overrides,
  };
}
