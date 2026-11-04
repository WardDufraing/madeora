import type { PetResult } from "./shapes";

export type {
  MedicalAccessList,
  MedicalAttachment,
  MedicalEntry,
  MedicalEntryDetail,
  PetDetail,
  PetList,
  PetMedical,
  PetMedicalDetails,
  PetResult,
  PetSummary,
} from "./shapes";

/**
 * The HTTP contract of pets (S31). Every mutation is same-origin JSON, checked again by the database
 * with the person's own session. Ids of new pets and entries come from the client, so a retry
 * returns the same row instead of a second one. Revision-checked changes answer `409 stale` with the
 * current revision.
 *
 * - `GET /api/v1/pets?homeId=` → `200 { list }`; `POST` `{ id, homeId, name }` creates.
 * - `GET|PATCH|DELETE /api/v1/pets/:id` (basic profile; replace it; to the trash).
 * - `GET|PUT /api/v1/pets/:id/medical` (medical view: details and entries; replace the details).
 * - `POST /api/v1/pets/:id/medical-entries` `{ id, entry }`.
 * - `GET|PATCH|DELETE /api/v1/pet-medical-entries/:id`.
 * - `POST /api/v1/pets/:id/photo` (opens a photo upload; finalize applies it); `DELETE` removes it.
 * - `POST /api/v1/pet-medical-entries/:id/attachments` (opens an upload; finalize attaches it).
 * - `DELETE /api/v1/pet-medical-attachments/:id` (to the trash).
 * - `GET|PUT /api/v1/homes/:homeId/pet-medical-access` (who has medical access; set one member's).
 * - `GET|POST /api/v1/pets/:id/care` (care activities; `{ id, activity, schedule }` creates one).
 * - `GET|PATCH|DELETE /api/v1/pet-care/:id` (one activity; `{ revision, activity, schedule?, from? }`
 *   changes it, the schedule from `from` on; to the trash). `POST /api/v1/pet-care/:id/state`
 *   `{ revision, state }` pauses, resumes or ends it.
 * - `POST /api/v1/pet-care-occurrences/:id` `{ action, revision, ... }`: complete, skip, reopen,
 *   correct, or change only this occurrence.
 * - `GET /api/v1/pet-care?homeId=&petId=&days=&who=&count=` (the pet-care widget's rows).
 *
 * Someone without medical view gets `404 not-found` from every medical route, exactly like a pet or
 * entry that does not exist.
 */
export const PETS_ENDPOINT = "/api/v1/pets";

export const PET_CARE_ENDPOINT = "/api/v1/pet-care";

export function careEndpoint(activityId: string, part?: "state"): string {
  const base = `${PET_CARE_ENDPOINT}/${encodeURIComponent(activityId)}`;
  return part ? `${base}/${part}` : base;
}

export function careOccurrenceEndpoint(occurrenceId: string): string {
  return `/api/v1/pet-care-occurrences/${encodeURIComponent(occurrenceId)}`;
}

export function petEndpoint(
  petId: string,
  part?: "medical" | "medical-entries" | "photo" | "care",
): string {
  const base = `${PETS_ENDPOINT}/${encodeURIComponent(petId)}`;
  return part ? `${base}/${part}` : base;
}

export function medicalEntryEndpoint(entryId: string, part?: "attachments"): string {
  const base = `/api/v1/pet-medical-entries/${encodeURIComponent(entryId)}`;
  return part ? `${base}/${part}` : base;
}

export function medicalAttachmentEndpoint(attachmentId: string): string {
  return `/api/v1/pet-medical-attachments/${encodeURIComponent(attachmentId)}`;
}

export function medicalAccessEndpoint(homeId: string): string {
  return `/api/v1/homes/${encodeURIComponent(homeId)}/pet-medical-access`;
}

export type PetErrorCode =
  | "forbidden"
  | "unsupported-media-type"
  | "too-large"
  | "unauthenticated"
  | "invalid"
  | "not-found"
  | "not-permitted"
  | "stale"
  | "id-taken"
  | "limit-reached"
  | "closed"
  | "invalid-member"
  | "invalid-dates"
  | "invalid-state"
  | "failed";

export interface PetErrorResponse {
  readonly error: PetErrorCode;
  readonly revision?: number;
  readonly fields?: readonly string[];
}

/** What a refused or failed request means to the person. */
export type PetFailure =
  | "signedOut"
  | "invalid"
  | "notFound"
  | "notPermitted"
  | "stale"
  | "idTaken"
  | "limitReached"
  | "closed"
  | "invalidMember"
  | "invalidDates"
  | "invalidState"
  | "network"
  | "failed";

const failures: { readonly [C in PetErrorCode]?: PetFailure } = {
  unauthenticated: "signedOut",
  invalid: "invalid",
  "not-found": "notFound",
  "not-permitted": "notPermitted",
  stale: "stale",
  "id-taken": "idTaken",
  "limit-reached": "limitReached",
  closed: "closed",
  "invalid-member": "invalidMember",
  "invalid-dates": "invalidDates",
  "invalid-state": "invalidState",
};

export class PetRequestError extends Error {
  constructor(
    readonly failure: PetFailure,
    readonly fields: readonly string[] = [],
  ) {
    super(`Pet request failed: ${failure}`);
    this.name = "PetRequestError";
  }
}

/** Sends one pets request; answers the JSON body or throws a PetRequestError. */
export async function sendPetRequest<T = PetResult>(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  body: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new PetRequestError("network");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const code = typeof record.error === "string" ? (record.error as PetErrorCode) : "failed";
    const fields = Array.isArray(record.fields)
      ? record.fields.filter((field): field is string => typeof field === "string")
      : [];
    throw new PetRequestError(failures[code] ?? "failed", fields);
  }
  return payload as T;
}
