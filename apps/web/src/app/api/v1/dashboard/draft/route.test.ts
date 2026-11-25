import type { Mock } from "vitest";

import { addWidget } from "@/dashboard/layout";
import { homeStarterLayout, personalStarterLayout } from "@/dashboard/starter";

import { PUT as savePut } from "../route";
import { DELETE, GET, PUT } from "./route";

interface State {
  identity: { userId: string } | null;
  homes: { id: string; name: string; timeZone: string; role: string }[];
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  homes: [],
  rpc: vi.fn(),
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const OTHER_HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0002";
const WIDGET_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0200";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/homes/server", () => ({
  listMyHomes: () => Promise.resolve({ status: "ok", homes: state.homes }),
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

function request(path: string, method: string, body?: unknown, headers = sameOrigin): Request {
  return new Request(`https://madeora.example/api/v1/dashboard${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

interface Database {
  readonly canEdit?: boolean;
  readonly notMember?: boolean;
  readonly draft?: unknown;
  readonly draftOutcome?: string;
  readonly saveOutcome?: string;
}

/** The database, answering each RPC this route calls. */
function database({
  canEdit = true,
  notMember = false,
  draft = null,
  draftOutcome = "saved",
  saveOutcome = "saved",
}: Database = {}) {
  state.rpc.mockImplementation((name) => {
    if (notMember) return { data: null, error: { code: "42501", message: "not permitted" } };
    switch (name) {
      case "get_dashboard":
        return {
          data: [
            { layout: null, revision: 3, can_edit: canEdit, can_undo: false, updated_at: null },
          ],
          error: null,
        };
      case "get_dashboard_draft":
        return { data: draft ? [draft] : [], error: null };
      case "save_dashboard_draft":
        return {
          data: [
            {
              outcome: draftOutcome,
              updated_at: draftOutcome === "saved" ? "2026-11-25T10:00:00Z" : null,
            },
          ],
          error: null,
        };
      case "discard_dashboard_draft":
        return { data: "discarded", error: null };
      case "save_dashboard":
        return { data: [{ outcome: saveOutcome, revision: 4 }], error: null };
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
  state.homes = [{ id: HOME_ID, name: "Thuis", timeZone: "UTC", role: "member" }];
  state.rpc.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /api/v1/dashboard/draft (UX2b)", () => {
  it("answers no draft for the personal dashboard, asking the database with no Home", async () => {
    database();
    const response = await GET(request("/draft", "GET"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ draft: null });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(rpcArgs("get_dashboard_draft")).toEqual({});
  });

  it("returns a Home draft read like a saved layout, with both revisions for the conflict check", async () => {
    database({
      draft: {
        layout: homeStarterLayout,
        base_revision: 2,
        current_revision: 3,
        updated_at: "2026-11-24T09:00:00Z",
        expires_at: "2026-12-24T09:00:00Z",
      },
    });
    const response = await GET(request(`/draft?homeId=${HOME_ID}`, "GET"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      draft: {
        layout: homeStarterLayout,
        baseRevision: 2,
        currentRevision: 3,
        updatedAt: "2026-11-24T09:00:00Z",
        expiresAt: "2026-12-24T09:00:00Z",
      },
    });
    expect(rpcArgs("get_dashboard_draft")).toEqual({ p_home_id: HOME_ID });
  });

  it("never returns a personal widget on a Home draft (the reader drops it)", async () => {
    const forged = addWidget(homeStarterLayout, {
      id: WIDGET_ID,
      type: "notifications",
      hidden: false,
      config: {},
    });
    database({
      draft: {
        layout: forged,
        base_revision: 0,
        current_revision: 0,
        updated_at: "2026-11-24T09:00:00Z",
        expires_at: "2026-12-24T09:00:00Z",
      },
    });
    const body = (await (await GET(request(`/draft?homeId=${HOME_ID}`, "GET"))).json()) as {
      draft: { layout: { widgets: { type: string }[] } };
    };
    expect(body.draft.layout.widgets.map((w) => w.type)).not.toContain("notifications");
  });

  it("answers 404 for a Home the person does not belong to, 400 for a malformed id, 401 signed out", async () => {
    database({ notMember: true });
    expect((await GET(request(`/draft?homeId=${OTHER_HOME}`, "GET"))).status).toBe(404);
    expect((await GET(request("/draft?homeId=not-a-uuid", "GET"))).status).toBe(400);
    state.identity = null;
    expect((await GET(request("/draft", "GET"))).status).toBe(401);
  });
});

describe("PUT /api/v1/dashboard/draft (UX2b)", () => {
  it("autosaves a valid draft with its base revision, without touching the dashboard", async () => {
    database();
    const response = await PUT(
      request("/draft", "PUT", { target: home, layout: homeStarterLayout, baseRevision: 3 }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updatedAt: "2026-11-25T10:00:00Z" });
    expect(rpcArgs("save_dashboard_draft")).toEqual({
      p_layout: homeStarterLayout,
      p_base_revision: 3,
      p_home_id: HOME_ID,
    });
    expect(rpcArgs("save_dashboard")).toBeUndefined();
  });

  it("refuses a draft of a dashboard the person may only view, without storing it", async () => {
    database({ canEdit: false });
    const response = await PUT(
      request("/draft", "PUT", { target: home, layout: homeStarterLayout, baseRevision: 3 }),
    );
    expect(response.status).toBe(403);
    expect(rpcArgs("save_dashboard_draft")).toBeUndefined();
  });

  it("answers 403 when the database keeps no draft for this person (children, displays)", async () => {
    database({ draftOutcome: "not_permitted" });
    const response = await PUT(
      request("/draft", "PUT", {
        target: personal,
        layout: personalStarterLayout,
        baseRevision: 0,
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not-permitted" });
  });

  it("checks the layout like a save: no widget bound to a Home the person is not in", async () => {
    database();
    const bound = addWidget(personalStarterLayout, {
      id: WIDGET_ID,
      type: "home-members",
      hidden: false,
      config: {},
      source: { homeId: OTHER_HOME },
    });
    const response = await PUT(
      request("/draft", "PUT", { target: personal, layout: bound, baseRevision: 0 }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid", fields: ["layout.source"] });
    expect(rpcArgs("save_dashboard_draft")).toBeUndefined();
  });

  it("answers 404 for a forged Home and refuses a cross-site request", async () => {
    database({ notMember: true });
    const forged = await PUT(
      request("/draft", "PUT", {
        target: { kind: "home", homeId: OTHER_HOME },
        layout: homeStarterLayout,
        baseRevision: 0,
      }),
    );
    expect(forged.status).toBe(404);
    const crossSite = await PUT(
      request(
        "/draft",
        "PUT",
        { target: personal, layout: personalStarterLayout, baseRevision: 0 },
        { origin: "https://evil.example", host: "madeora.example" },
      ),
    );
    expect(crossSite.status).toBe(403);
  });
});

describe("DELETE /api/v1/dashboard/draft (UX2b)", () => {
  it("discards the person's draft of exactly that dashboard", async () => {
    database();
    const response = await DELETE(request("/draft", "DELETE", { target: home }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ discarded: true });
    expect(rpcArgs("discard_dashboard_draft")).toEqual({ p_home_id: HOME_ID });
  });
});

describe("PUT /api/v1/dashboard with commitDraft (Done)", () => {
  it("asks the database to drop the draft in the same transaction only on Done", async () => {
    database();
    await savePut(
      request("", "PUT", {
        target: personal,
        layout: personalStarterLayout,
        expectedRevision: 3,
        commitDraft: true,
      }),
    );
    expect(rpcArgs("save_dashboard")).toEqual({
      p_layout: personalStarterLayout,
      p_expected_revision: 3,
      p_commit_draft: true,
    });
    state.rpc.mockClear();
    await savePut(
      request("", "PUT", { target: personal, layout: personalStarterLayout, expectedRevision: 3 }),
    );
    expect(rpcArgs("save_dashboard")).not.toHaveProperty("p_commit_draft");
  });
});
