import "server-only";

import type { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";

import {
  careActivityDetailShape,
  homeCareShape,
  petCareShape,
  type CareActivityDetail,
  type HomeCare,
  type PetCare,
} from "./care-shapes";
import type { PetCareWho } from "./care-schema";
import { logPets } from "./log";
import {
  medicalAccessListSchema,
  medicalEntryDetailSchema,
  petDetailSchema,
  petListSchema,
  petMedicalSchema,
  type MedicalAccessList,
  type MedicalEntryDetail,
  type PetDetail,
  type PetList,
  type PetMedical,
} from "./shapes";

/**
 * Server reads of pets (S31), always with the signed-in person's own Supabase session: the database
 * answers only what they may see now. Medical reads answer "not found" for anyone without medical
 * view, exactly like a pet or entry that does not exist, so nothing tells them whether there is any.
 * Every answer is checked against its shape; nothing is cached across requests (personalized data,
 * architecture.md §9).
 */

export type Read<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "not-found" }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" };

function failed<T>(event: string, error: { readonly code?: string }): Read<T> {
  if (error.code === "42501") return { status: "not-found" };
  if (error.code === "22023" || error.code === "22P02") return { status: "invalid" };
  logPets(event, error.code);
  return { status: "unavailable" };
}

function parsed<S extends z.ZodType>(event: string, schema: S, data: unknown): Read<z.output<S>> {
  if (data === null) return { status: "not-found" };
  const result = schema.safeParse(data);
  if (!result.success) {
    logPets(event, "shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: result.data };
}

/** The Home's pets with the person's access; not found for a Home they are not in. */
export async function readPets(homeId: string): Promise<Read<PetList>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_pets", { p_home_id: homeId });
  if (error) return failed("pets.list_failed", error);
  return parsed("pets.list_failed", petListSchema, data);
}

/** One pet's basic profile; not found when the person may not see it. */
export async function readPet(petId: string): Promise<Read<PetDetail>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_pet", { p_pet_id: petId });
  if (error) return failed("pets.read_failed", error);
  return parsed("pets.read_failed", petDetailSchema, data);
}

/** A pet's medical information; not found without medical view. */
export async function readPetMedical(petId: string): Promise<Read<PetMedical>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_pet_medical", { p_pet_id: petId });
  if (error) return failed("pets.medical_read_failed", error);
  return parsed("pets.medical_read_failed", petMedicalSchema, data);
}

/** One medical entry; not found without medical view (also for a forged id). */
export async function readMedicalEntry(entryId: string): Promise<Read<MedicalEntryDetail>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_pet_medical_entry", { p_entry_id: entryId });
  if (error) return failed("pets.entry_read_failed", error);
  return parsed("pets.entry_read_failed", medicalEntryDetailSchema, data);
}

/** Who has medical access in a Home: all members for a grantor, only themselves for anyone else. */
export async function readMedicalAccess(homeId: string): Promise<Read<MedicalAccessList>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_pet_medical_access", { p_home_id: homeId });
  if (error) return failed("pets.access_read_failed", error);
  return parsed("pets.access_read_failed", medicalAccessListSchema, data);
}

/** A pet's care activities (concealed where needed); brings its schedules up to date first. */
export async function readPetCare(petId: string): Promise<Read<PetCare>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_pet_care", { p_pet_id: petId });
  if (error) return failed("pets.care_read_failed", error);
  return parsed("pets.care_read_failed", petCareShape, data);
}

/** One care activity with its open and recent occurrences; not found when the person may not see it. */
export async function readCareActivity(activityId: string): Promise<Read<CareActivityDetail>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_pet_care_activity", {
    p_activity_id: activityId,
  });
  if (error) return failed("pets.care_activity_read_failed", error);
  return parsed("pets.care_activity_read_failed", careActivityDetailShape, data);
}

/** The pet-care widget's rows; not found for a Home the person is not in. */
export async function readHomeCare(
  homeId: string,
  options: {
    readonly petId: string | null;
    readonly days: 1 | 3 | 7;
    readonly who: PetCareWho;
    readonly count: 5 | 10 | 15;
  },
): Promise<Read<HomeCare>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_home_pet_care", {
    p_home_id: homeId,
    // The generated types read every parameter as required; null means every pet.
    p_pet_id: options.petId as string,
    p_days: options.days,
    p_who: options.who,
    p_limit: options.count,
  });
  if (error) return failed("pets.care_widget_failed", error);
  return parsed("pets.care_widget_failed", homeCareShape, data);
}

/**
 * The pet, category and (unless concealed from the reader) title of each occurrence named in the
 * person's notifications, for those they may still see. Empty when it cannot be read.
 */
export async function petCareNoticeNames(
  occurrenceIds: readonly string[],
): Promise<
  Map<
    string,
    { readonly petName: string; readonly title: string | null; readonly category: string }
  >
> {
  const names = new Map<
    string,
    { readonly petName: string; readonly title: string | null; readonly category: string }
  >();
  if (occurrenceIds.length === 0) return names;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("pet_care_notice_names", {
    p_occurrence_ids: [...new Set(occurrenceIds)].slice(0, 100),
  });
  if (error) {
    logPets("pets.care_notice_names_failed", error.code);
    return names;
  }
  for (const row of data) {
    names.set(row.occurrence_id, {
      petName: row.pet_name,
      title: row.title,
      category: row.category,
    });
  }
  return names;
}
