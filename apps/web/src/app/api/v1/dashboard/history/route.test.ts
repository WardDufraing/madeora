import type { Mock } from "vitest";

import { personalStarterLayout } from "@/dashboard/starter";

import { GET } from "./route";
import { POST } from "./restore/route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const VERSION_A = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0301";
const VERSION_B = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0302";
const FOREIGN_VERSION = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0399";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args: Record<string, unknown>) => Promise.resolve(state.rpc(name, args)),
    }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };
const personal = { kind: "personal" } as const;
const home = { kind: "home", homeId: HOME_ID } as const;

function get(query = ""): Request {
  return new Request(`https://madeora.example/api/v1/dashboard/history${query}`);
}

function post(body: unknown, headers: Record<string, string> = sameOrigin): Request {
  return new Request("https://madeora.example/api/v1/dashboard/history/restore", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const storedLayout = JSON.parse(JSON.stringify(personalStarterLayout)) as Record<string, unknown>;

interface Database {
  readonly canEdit?: boolean;
  readonly notMember?: boolean;
  readonly historyError?: { code: string; message: string };
  readonly restoreOutcome?: string;
}

function database({
  canEdit = true,
  notMember = false,
  historyError,
  restoreOutcome = "saved",
}: Database = {}) {
  state.rpc.mockImplementation((name) => {
    if (notMember) return { data: null, error: { code: "42501", message: "not permitted" } };
    switch (name) {
      case "get_dashboard":
        return {
          data: [{ layout: storedLayout, revision: 5, can_edit: canEdit, can_undo: true }],
          error: null,
        };
      case "list_dashboard_versions":
        if (historyError) return { data: null, error: historyError };
        return {
          data: [
            {
              version_id: VERSION_B,
              revision: 5,
              layout: storedLayout,
              reason: "restore",
              saved_by_me: false,
              created_at: "2026-11-25T10:00:00Z",
              is_current: true,
            },
            {
              version_id: VERSION_A,
              revision: 4,
              layout: { ...storedLayout, widgets: "broken" },
              reason: "save",
              saved_by_me: true,
              created_at: "2026-11-24T10:00:00Z",
              is_current: false,
            },
          ],
          error: null,
        };
      case "restore_dashboard_version":
        return {
          data: [{ outcome: restoreOutcome, revision: restoreOutcome === "conflict" ? 7 : 6 }],
          error: null,
        };
      default:
        throw new Error(`unexpected rpc ${name}`);
    }
  });
}

function rpcArgs(name: string): Record<string, unknown> | undefined {
  return state.rpc.mock.calls.find(([called]) => called === name)?.[1];
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /api/v1/dashboard/history", () => {
  it("answers the personal history with previews and never widget settings", async () => {
    database();
    const response = await GET(get());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(rpcArgs("list_dashboard_versions")).toEqual({});
    const body = (await response.json()) as {
      versions: {
        id: string;
        reason: string;
        isCurrent: boolean;
        dropped: boolean;
        preview: { widgets: Record<string, unknown>[] };
      }[];
    };
    expect(body.versions.map((v) => [v.id, v.reason, v.isCurrent])).toEqual([
      [VERSION_B, "restore", true],
      [VERSION_A, "save", false],
    ]);
    expect(body.versions[0]?.preview.widgets.length).toBe(personalStarterLayout.widgets.length);
    for (const widget of body.versions[0]?.preview.widgets ?? []) {
      expect(Object.keys(widget).sort()).toEqual(["hidden", "id", "type"]);
    }
    // A version the reader cannot use is shown empty and flagged, never failing the list.
    expect(body.versions[1]?.dropped).toBe(true);
  });

  it("asks for a Home's shared-default history by name", async () => {
    database();
    const response = await GET(get(`?homeId=${HOME_ID}`));
    expect(response.status).toBe(200);
    expect(rpcArgs("list_dashboard_versions")).toEqual({
      p_home_id: HOME_ID,
      p_target: "default",
    });
  });

  it("refuses a Member who may not edit the Home dashboard", async () => {
    database({ canEdit: false });
    expect((await GET(get(`?homeId=${HOME_ID}`))).status).toBe(403);
    expect(rpcArgs("list_dashboard_versions")).toBeUndefined();
  });

  it("answers 404 for a Home the person does not belong to", async () => {
    database({ notMember: true });
    expect((await GET(get(`?homeId=${HOME_ID}`))).status).toBe(404);
  });

  it("answers 403 when the database refuses the history after the check", async () => {
    database({ historyError: { code: "42501", message: "not permitted" } });
    expect((await GET(get(`?homeId=${HOME_ID}`))).status).toBe(403);
  });

  it("refuses signed-out readers, malformed Home ids and unknown parameters", async () => {
    database();
    state.identity = null;
    expect((await GET(get())).status).toBe(401);
    state.identity = { userId: "user-a" };
    expect((await GET(get("?homeId=nope"))).status).toBe(400);
    expect((await GET(get("?target=mine"))).status).toBe(400);
  });
});

describe("POST /api/v1/dashboard/history/restore", () => {
  it("restores a version of the target as a new commit", async () => {
    database();
    const response = await POST(post({ target: home, versionId: VERSION_A, expectedRevision: 5 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: 6 });
    expect(rpcArgs("restore_dashboard_version")).toEqual({
      p_version_id: VERSION_A,
      p_expected_revision: 5,
    });
  });

  it("refuses a version that is not in this dashboard's history", async () => {
    database();
    const response = await POST(
      post({ target: personal, versionId: FOREIGN_VERSION, expectedRevision: 5 }),
    );
    expect(response.status).toBe(404);
    expect(rpcArgs("restore_dashboard_version")).toBeUndefined();
  });

  it("answers 409 with the current revision when someone saved since", async () => {
    database({ restoreOutcome: "conflict" });
    const response = await POST(
      post({ target: personal, versionId: VERSION_A, expectedRevision: 5 }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict", revision: 7 });
  });

  it("maps the database's not_found and not_permitted outcomes", async () => {
    database({ restoreOutcome: "not_found" });
    expect(
      (await POST(post({ target: personal, versionId: VERSION_A, expectedRevision: 5 }))).status,
    ).toBe(404);
    database({ restoreOutcome: "not_permitted" });
    expect(
      (await POST(post({ target: personal, versionId: VERSION_A, expectedRevision: 5 }))).status,
    ).toBe(403);
  });

  it("refuses a Member who may not edit, and a foreign Home", async () => {
    database({ canEdit: false });
    expect(
      (await POST(post({ target: home, versionId: VERSION_A, expectedRevision: 5 }))).status,
    ).toBe(403);
    database({ notMember: true });
    expect(
      (await POST(post({ target: home, versionId: VERSION_A, expectedRevision: 5 }))).status,
    ).toBe(404);
    expect(rpcArgs("restore_dashboard_version")).toBeUndefined();
  });

  it("refuses cross-site requests and invalid bodies", async () => {
    database();
    expect(
      (
        await POST(
          post(
            { target: personal, versionId: VERSION_A, expectedRevision: 5 },
            { origin: "https://evil.example", host: "madeora.example" },
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (await POST(post({ target: personal, versionId: VERSION_A, expectedRevision: 0 }))).status,
    ).toBe(400);
    expect(
      (await POST(post({ target: personal, versionId: "nope", expectedRevision: 5 }))).status,
    ).toBe(400);
    expect(
      (
        await POST(
          post({ target: personal, versionId: VERSION_A, expectedRevision: 5, extra: true }),
        )
      ).status,
    ).toBe(400);
  });
});
