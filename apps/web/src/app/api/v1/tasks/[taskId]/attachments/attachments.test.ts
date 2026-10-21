import type { Mock } from "vitest";

import { DELETE as removeAttachment } from "../../../task-attachments/[attachmentId]/route";
import { GET as impact } from "./impact/route";
import { GET as list } from "./route";
import { POST as intent } from "./upload-intents/route";

interface State {
  identity: { userId: string } | null;
  storageOn: boolean;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
  presignPut: Mock;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  storageOn: true,
  rpc: vi.fn(),
  presignPut: vi.fn(),
}));

const TASK = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const FILE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";
const ATTACHMENT = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0a01";
const ENTRY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0e01";
const REQUEST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0b01";
const UPLOAD_KEY = `h/${"a".repeat(64)}`;

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
  getStorage: () => (state.storageOn ? { objects: { presignPut: state.presignPut } } : null),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };
const taskParams = { params: Promise.resolve({ taskId: TASK }) };
const attachmentParams = { params: Promise.resolve({ attachmentId: ATTACHMENT }) };

function request(path: string, method: string, body?: unknown, headers = sameOrigin): Request {
  return new Request(`https://madeora.example/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const intentBody = {
  contentType: "application/pdf",
  size: 1234,
  name: "Lease.pdf",
  requestId: REQUEST,
};

function answers(outcomes: Record<string, unknown>) {
  state.rpc.mockImplementation((name) =>
    name in outcomes
      ? { data: outcomes[name], error: null }
      : { data: null, error: { code: "XX000", message: "unexpected" } },
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.storageOn = true;
  state.rpc.mockReset();
  state.presignPut.mockReset().mockReturnValue({
    url: "https://store.example/put",
    headers: { "content-type": "application/pdf" },
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/tasks/:id/attachments/upload-intents", () => {
  const send = (body: unknown = intentBody, headers = sameOrigin) =>
    intent(request(`/tasks/${TASK}/attachments/upload-intents`, "POST", body, headers), taskParams);

  it("opens an upload through the database and signs a link bound to its type and size", async () => {
    answers({
      create_task_attachment_intent: [
        {
          outcome: "ok",
          file_id: FILE,
          upload_key: UPLOAD_KEY,
          expires_at: "2026-10-20T10:15:00Z",
        },
      ],
    });
    const response = await send();
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      fileId: FILE,
      uploadUrl: "https://store.example/put",
      headers: { "content-type": "application/pdf" },
      expiresAt: "2026-10-20T10:15:00Z",
    });
    expect(state.rpc).toHaveBeenCalledWith("create_task_attachment_intent", {
      p_task_id: TASK,
      p_content_type: "application/pdf",
      p_size: 1234,
      p_name: "Lease.pdf",
      p_request_id: REQUEST,
    });
    expect(state.presignPut).toHaveBeenCalledWith(UPLOAD_KEY, {
      contentType: "application/pdf",
      contentLength: 1234,
      expiresInSeconds: 300,
    });
  });

  it("refuses another site's request, a signed-out person and invalid input before the database", async () => {
    expect(
      (await send(intentBody, { origin: "https://evil.example", host: "madeora.example" })).status,
    ).toBe(403);
    state.identity = null;
    expect((await send()).status).toBe(401);
    state.identity = { userId: "user-a" };
    expect((await send({ ...intentBody, contentType: "text/html" })).status).toBe(400);
    expect((await send({ ...intentBody, name: "a‮b.pdf" })).status).toBe(400);
    expect((await send({ ...intentBody, size: 11 * 1024 * 1024 })).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("says when storage is off", async () => {
    state.storageOn = false;
    const response = await send();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "storage-unavailable" });
  });

  it.each([
    ["not_found", 404, "not-found"],
    ["not_permitted", 403, "not-permitted"],
    ["limit_reached", 409, "limit-reached"],
    ["storage_full", 409, "storage-full"],
    ["rate_limited", 429, "rate-limited"],
    ["conflict", 409, "conflict"],
  ])("maps %s to %i %s and signs nothing", async (outcome, status, error) => {
    answers({ create_task_attachment_intent: [{ outcome }] });
    const response = await send();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(state.presignPut).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/tasks/:id/attachments", () => {
  const view = {
    canAdd: true,
    canChangeSeries: false,
    limit: 10,
    attachments: [
      {
        id: ATTACHMENT,
        fileId: FILE,
        name: "Lease.pdf",
        contentType: "application/pdf",
        size: 1234,
        fromSeries: false,
        seriesActive: false,
        addedAt: "2026-10-20T10:00:00Z",
        addedBy: { me: true, member: null },
        canRemove: true,
      },
    ],
  };

  it("answers what the database reports for the viewer", async () => {
    answers({ list_task_attachments: view });
    const response = await list(request(`/tasks/${TASK}/attachments`, "GET"), taskParams);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(view);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 404 for a task the viewer cannot see", async () => {
    answers({ list_task_attachments: null });
    expect((await list(request(`/tasks/${TASK}/attachments`, "GET"), taskParams)).status).toBe(404);
  });

  it("answers 401 when signed out", async () => {
    state.identity = null;
    expect((await list(request(`/tasks/${TASK}/attachments`, "GET"), taskParams)).status).toBe(401);
  });
});

describe("GET /api/v1/tasks/:id/attachments/impact", () => {
  it("previews a series scope", async () => {
    const preview = { scope: "series", changed: 3, kept: 1, full: 0, completed: 2 };
    answers({ task_attachment_scope_impact: [{ outcome: "preview", impact: preview }] });
    const response = await impact(
      request(`/tasks/${TASK}/attachments/impact?scope=series`, "GET"),
      taskParams,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ impact: preview });
  });

  it("refuses the scope 'this' and maps refusals", async () => {
    expect(
      (await impact(request(`/tasks/${TASK}/attachments/impact?scope=this`, "GET"), taskParams))
        .status,
    ).toBe(400);
    answers({ task_attachment_scope_impact: [{ outcome: "not_permitted", impact: null }] });
    expect(
      (await impact(request(`/tasks/${TASK}/attachments/impact?scope=series`, "GET"), taskParams))
        .status,
    ).toBe(403);
  });
});

describe("DELETE /api/v1/task-attachments/:id", () => {
  const send = (body: unknown, headers = sameOrigin) =>
    removeAttachment(
      request(`/task-attachments/${ATTACHMENT}`, "DELETE", body, headers),
      attachmentParams,
    );

  it("moves the attachment to the trash and answers the entry", async () => {
    answers({ remove_task_attachment: [{ outcome: "removed", entry_id: ENTRY, impact: null }] });
    const response = await send({ scope: "this" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entryId: ENTRY, impact: null });
    expect(state.rpc).toHaveBeenCalledWith("remove_task_attachment", {
      p_attachment_id: ATTACHMENT,
      p_scope: "this",
      p_dry_run: false,
    });
  });

  it("previews a series-wide removal without removing anything", async () => {
    const preview = { scope: "following", changed: 2, kept: 0, full: 0, completed: 1 };
    answers({ remove_task_attachment: [{ outcome: "preview", entry_id: null, impact: preview }] });
    const response = await send({ scope: "following", dryRun: true });
    expect(await response.json()).toEqual({ entryId: null, impact: preview });
    expect(state.rpc).toHaveBeenCalledWith(
      "remove_task_attachment",
      expect.objectContaining({ p_dry_run: true }),
    );
  });

  it.each([
    ["not_found", 404],
    ["not_permitted", 403],
    ["scope_unavailable", 409],
  ])("maps %s to %i", async (outcome, status) => {
    answers({ remove_task_attachment: [{ outcome, entry_id: null, impact: null }] });
    expect((await send({ scope: "this" })).status).toBe(status);
  });

  it("refuses another site's request and an unknown scope", async () => {
    expect(
      (await send({}, { origin: "https://evil.example", host: "madeora.example" })).status,
    ).toBe(403);
    expect((await send({ scope: "all" })).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
