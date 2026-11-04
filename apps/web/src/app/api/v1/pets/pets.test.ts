// S31: the pets routes. The database decides every right and value (tests/db/rls/pets.test.sql);
// these tests check what the routes send it and how they answer, above all that a medical read or
// change by someone without medical access answers exactly like one that does not exist.
import type { Mock } from "vitest";

import {
  ATTACHMENT,
  ENTRY,
  HOME,
  MEMBERSHIP,
  PET,
  medicalAccessList,
  medicalEntryDetail,
  petDetail,
  petList,
  petMedical,
} from "@/pets/testing";

import { GET as readAccess, PUT as setAccess } from "../homes/[homeId]/pet-medical-access/route";
import { DELETE as removeAttachment } from "../pet-medical-attachments/[attachmentId]/route";
import { POST as attachmentIntent } from "../pet-medical-entries/[entryId]/attachments/route";
import {
  DELETE as deleteEntry,
  GET as readEntry,
  PATCH as updateEntry,
} from "../pet-medical-entries/[entryId]/route";
import { POST as createEntry } from "./[petId]/medical-entries/route";
import { GET as readMedical, PUT as setMedical } from "./[petId]/medical/route";
import { DELETE as removePhoto, POST as photoIntent } from "./[petId]/photo/route";
import { DELETE as deletePet, GET as readPet, PATCH as updatePet } from "./[petId]/route";
import { GET as list, POST as create } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
  storage: boolean;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  rpc: vi.fn(),
  storage: true,
}));

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args: Record<string, unknown>) => Promise.resolve(state.rpc(name, args)),
    }),
}));
vi.mock("@/storage/server", () => ({
  getStorage: () =>
    state.storage
      ? {
          objects: {
            presignPut: (key: string) => ({
              url: `https://storage.example/${key}`,
              headers: { "content-type": "application/pdf" },
            }),
          },
        }
      : null,
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };
const crossSite = { origin: "https://evil.example", host: "madeora.example" };

function request(path: string, method: string, body?: unknown, headers = sameOrigin): Request {
  return new Request(`https://madeora.example/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const petParams = { params: Promise.resolve({ petId: PET }) };
const entryParams = { params: Promise.resolve({ entryId: ENTRY }) };
const homeParams = { params: Promise.resolve({ homeId: HOME }) };

function answers(outcomes: Record<string, unknown>) {
  state.rpc.mockImplementation((name) =>
    name in outcomes
      ? { data: outcomes[name], error: null }
      : { data: null, error: { code: "XX000", message: "unexpected" } },
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.storage = true;
  state.rpc.mockReset();
});

const profile = {
  name: "Miso",
  species: "cat",
  breed: "",
  unknown: ["breed"],
  weight: 4.25,
  weightUnit: "kg",
};

describe("checks every request makes", () => {
  it("refuses a cross-site change and a signed-out person before the database", async () => {
    const body = { id: PET, homeId: HOME, name: "Miso" };
    expect((await create(request("/pets", "POST", body, crossSite))).status).toBe(403);
    state.identity = null;
    expect((await create(request("/pets", "POST", body))).status).toBe(401);
    expect((await readPet(request(`/pets/${PET}`, "GET"), petParams)).status).toBe(401);
    expect((await readMedical(request(`/pets/${PET}/medical`, "GET"), petParams)).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers a malformed id as not found without asking the database", async () => {
    const bad = { params: Promise.resolve({ entryId: "nope" }) };
    expect((await readEntry(request("/pet-medical-entries/nope", "GET"), bad)).status).toBe(404);
    expect(
      (await deleteEntry(request("/pet-medical-entries/nope", "DELETE", { revision: 1 }), bad))
        .status,
    ).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses invalid input at its field before the database", async () => {
    const response = await updatePet(
      request(`/pets/${PET}`, "PATCH", {
        revision: 2,
        profile: { name: "Miso", weight: 4.2, vetEmail: "not-an-email" },
      }),
      petParams,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid" });
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("pets and their basic profile", () => {
  it("lists a Home's pets, and answers a Home the person is not in as not found", async () => {
    answers({ list_pets: petList() });
    const response = await list(request(`/pets?homeId=${HOME}`, "GET"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ list: { access: "manage", limit: 50 } });
    expect(state.rpc).toHaveBeenCalledWith("list_pets", { p_home_id: HOME });

    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not permitted" } });
    expect((await list(request(`/pets?homeId=${HOME}`, "GET"))).status).toBe(404);
  });

  it("creates a pet with only its name, trimmed", async () => {
    answers({ create_pet: { outcome: "created", id: PET, revision: 1 } });
    const response = await create(
      request("/pets", "POST", { id: PET, homeId: HOME, name: " Miso " }),
    );
    expect(response.status).toBe(201);
    expect(state.rpc).toHaveBeenCalledWith("create_pet", {
      p_id: PET,
      p_home_id: HOME,
      p_name: "Miso",
    });
  });

  it("answers the pet limit and a taken id with their own codes", async () => {
    answers({ create_pet: { outcome: "limit_reached" } });
    const body = { id: PET, homeId: HOME, name: "Miso" };
    expect(await (await create(request("/pets", "POST", body))).json()).toEqual({
      error: "limit-reached",
    });
    answers({ create_pet: { outcome: "id_taken" } });
    expect((await create(request("/pets", "POST", body))).status).toBe(409);
  });

  it("sends the whole profile with every missing field as not entered", async () => {
    answers({ update_pet: { outcome: "saved", revision: 3 } });
    const response = await updatePet(
      request(`/pets/${PET}`, "PATCH", { revision: 2, profile }),
      petParams,
    );
    expect(response.status).toBe(200);
    const args = state.rpc.mock.calls[0]?.[1];
    expect(args).toMatchObject({ p_pet_id: PET, p_expected_revision: 2 });
    expect(args?.p_profile).toMatchObject({
      name: "Miso",
      species: "cat",
      breed: null,
      unknown: ["breed"],
      weight: 4.25,
      weightUnit: "kg",
      birthDate: null,
      diet: null,
      vetEmail: null,
    });
  });

  it("answers a stale revision with the current one", async () => {
    answers({ update_pet: { outcome: "stale", revision: 5 } });
    const response = await updatePet(
      request(`/pets/${PET}`, "PATCH", { revision: 2, profile }),
      petParams,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "stale", revision: 5 });
  });

  it("moves a pet to the trash, and refuses someone who may not manage pets", async () => {
    answers({ delete_pet: { outcome: "deleted", entryId: ENTRY } });
    expect(
      (await deletePet(request(`/pets/${PET}`, "DELETE", { revision: 2 }), petParams)).status,
    ).toBe(200);
    answers({ delete_pet: { outcome: "not_permitted" } });
    expect(
      (await deletePet(request(`/pets/${PET}`, "DELETE", { revision: 2 }), petParams)).status,
    ).toBe(403);
  });

  it("reads one pet's profile", async () => {
    answers({ get_pet: petDetail() });
    const response = await readPet(request(`/pets/${PET}`, "GET"), petParams);
    expect(await response.json()).toMatchObject({ pet: { id: PET, unknown: ["breed"] } });
  });
});

describe("medical information", () => {
  it("answers someone without medical view exactly like a pet without records", async () => {
    // The database answers null for both: no medical view, and a pet that does not exist.
    answers({ get_pet_medical: null, get_pet_medical_entry: null });
    const medical = await readMedical(request(`/pets/${PET}/medical`, "GET"), petParams);
    const entry = await readEntry(request(`/pet-medical-entries/${ENTRY}`, "GET"), entryParams);
    expect(medical.status).toBe(404);
    expect(entry.status).toBe(404);
    expect(await medical.json()).toEqual({ error: "not-found" });
    expect(await entry.json()).toEqual({ error: "not-found" });
  });

  it("reads the details and entries for a medical viewer", async () => {
    answers({ get_pet_medical: petMedical(), get_pet_medical_entry: medicalEntryDetail() });
    const medical = await readMedical(request(`/pets/${PET}/medical`, "GET"), petParams);
    expect(await medical.json()).toMatchObject({
      medical: { level: "manage", details: { none: ["allergies"] } },
    });
    const entry = await readEntry(request(`/pet-medical-entries/${ENTRY}`, "GET"), entryParams);
    expect(await entry.json()).toMatchObject({ entry: { id: ENTRY, type: "vaccination" } });
  });

  it("sends the details with None and Unknown, and refuses a value marked None", async () => {
    answers({ set_pet_medical_details: { outcome: "saved", revision: 1 } });
    const details = { allergies: "", none: ["allergies"], unknown: ["microchip"] };
    const response = await setMedical(
      request(`/pets/${PET}/medical`, "PUT", { revision: 0, details }),
      petParams,
    );
    expect(response.status).toBe(200);
    expect(state.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_pet_id: PET,
      p_expected_revision: 0,
      p_details: { allergies: null, none: ["allergies"], unknown: ["microchip"] },
    });
    state.rpc.mockReset();
    const refused = await setMedical(
      request(`/pets/${PET}/medical`, "PUT", {
        revision: 1,
        details: { allergies: "Chicken", none: ["allergies"] },
      }),
      petParams,
    );
    expect(refused.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("adds an entry, and refuses a follow-up before the event", async () => {
    answers({ create_pet_medical_entry: { outcome: "created", id: ENTRY, revision: 1 } });
    const entry = { type: "vaccination", date: "2026-10-20", title: "Rabies" };
    const response = await createEntry(
      request(`/pets/${PET}/medical-entries`, "POST", { id: ENTRY, entry }),
      petParams,
    );
    expect(response.status).toBe(201);
    expect(state.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_id: ENTRY,
      p_pet_id: PET,
      p_entry: { type: "vaccination", date: "2026-10-20", title: "Rabies", followUpDate: null },
    });
    const refused = await updateEntry(
      request(`/pet-medical-entries/${ENTRY}`, "PATCH", {
        revision: 1,
        entry: { ...entry, followUpDate: "2026-10-01" },
      }),
      entryParams,
    );
    expect(refused.status).toBe(400);
  });

  it("answers a change by someone without medical view as not found", async () => {
    answers({ update_pet_medical_entry: { outcome: "not_found" } });
    const response = await updateEntry(
      request(`/pet-medical-entries/${ENTRY}`, "PATCH", {
        revision: 1,
        entry: { type: "other", date: "2026-10-20" },
      }),
      entryParams,
    );
    expect(response.status).toBe(404);
  });

  it("moves an entry and an attachment to the trash", async () => {
    answers({
      delete_pet_medical_entry: { outcome: "deleted", entryId: ENTRY },
      remove_pet_medical_attachment: { outcome: "removed", entryId: ENTRY },
    });
    expect(
      (
        await deleteEntry(
          request(`/pet-medical-entries/${ENTRY}`, "DELETE", { revision: 1 }),
          entryParams,
        )
      ).status,
    ).toBe(200);
    const response = await removeAttachment(
      request(`/pet-medical-attachments/${ATTACHMENT}`, "DELETE", {}),
      { params: Promise.resolve({ attachmentId: ATTACHMENT }) },
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenLastCalledWith("remove_pet_medical_attachment", {
      p_attachment_id: ATTACHMENT,
    });
  });
});

describe("uploads", () => {
  const intent = (outcome: string) => [
    {
      outcome,
      file_id: outcome === "ok" ? ATTACHMENT : null,
      upload_key: outcome === "ok" ? "home/x" : null,
      expires_at: outcome === "ok" ? "2026-11-10T10:00:00Z" : null,
    },
  ];
  const document = {
    contentType: "application/pdf",
    size: 120_000,
    name: "certificate.pdf",
    requestId: MEMBERSHIP,
  };

  it("opens an attachment upload with a signed link", async () => {
    answers({ create_pet_medical_attachment_intent: intent("ok") });
    const response = await attachmentIntent(
      request(`/pet-medical-entries/${ENTRY}/attachments`, "POST", document),
      entryParams,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ fileId: ATTACHMENT });
    expect(state.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_entry_id: ENTRY,
      p_content_type: "application/pdf",
      p_name: "certificate.pdf",
    });
  });

  it("refuses another type, the limit, and someone without medical view as not found", async () => {
    const refused = await attachmentIntent(
      request(`/pet-medical-entries/${ENTRY}/attachments`, "POST", {
        ...document,
        contentType: "text/plain",
      }),
      entryParams,
    );
    expect(refused.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
    answers({ create_pet_medical_attachment_intent: intent("limit_reached") });
    expect(
      (
        await attachmentIntent(
          request(`/pet-medical-entries/${ENTRY}/attachments`, "POST", document),
          entryParams,
        )
      ).status,
    ).toBe(409);
    answers({ create_pet_medical_attachment_intent: intent("not_found") });
    expect(
      (
        await attachmentIntent(
          request(`/pet-medical-entries/${ENTRY}/attachments`, "POST", document),
          entryParams,
        )
      ).status,
    ).toBe(404);
  });

  it("opens a photo upload, answers without storage, and removes a photo", async () => {
    answers({ create_pet_photo_intent: intent("ok") });
    const photo = { contentType: "image/jpeg", size: 2000, requestId: MEMBERSHIP };
    expect(
      (await photoIntent(request(`/pets/${PET}/photo`, "POST", photo), petParams)).status,
    ).toBe(201);
    state.storage = false;
    expect(
      (await photoIntent(request(`/pets/${PET}/photo`, "POST", photo), petParams)).status,
    ).toBe(503);
    answers({ remove_pet_photo: { outcome: "removed", revision: 3 } });
    expect(
      (await removePhoto(request(`/pets/${PET}/photo`, "DELETE", { revision: 2 }), petParams))
        .status,
    ).toBe(200);
  });
});

describe("medical access", () => {
  it("lists who has access for a grantor", async () => {
    answers({ list_pet_medical_access: medicalAccessList() });
    const response = await readAccess(
      request(`/homes/${HOME}/pet-medical-access`, "GET"),
      homeParams,
    );
    expect(await response.json()).toMatchObject({ access: { canGrant: true } });
  });

  it("sets a level, and refuses someone who may not grant it", async () => {
    answers({ set_pet_medical_access: "ok" });
    const body = { membershipId: MEMBERSHIP, level: "view" };
    const response = await setAccess(
      request(`/homes/${HOME}/pet-medical-access`, "PUT", body),
      homeParams,
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("set_pet_medical_access", {
      p_home_id: HOME,
      p_membership_id: MEMBERSHIP,
      p_level: "view",
    });
    answers({ set_pet_medical_access: "not_permitted" });
    expect(
      (await setAccess(request(`/homes/${HOME}/pet-medical-access`, "PUT", body), homeParams))
        .status,
    ).toBe(403);
    const invalid = await setAccess(
      request(`/homes/${HOME}/pet-medical-access`, "PUT", { ...body, level: "owner" }),
      homeParams,
    );
    expect(invalid.status).toBe(400);
  });
});
