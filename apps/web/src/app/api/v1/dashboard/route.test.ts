import type { Mock } from "vitest";

import { addWidget } from "@/dashboard/layout";
import { homeStarterLayout, personalStarterLayout } from "@/dashboard/starter";

import { POST as applyPost } from "./apply-template/route";
import { POST as resetPost } from "./reset/route";
import { PUT } from "./route";
import { POST as undoPost } from "./undo/route";

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
const TEMPLATE_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0100";
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

function request(path: string, method: string, body: unknown, headers = sameOrigin): Request {
  return new Request(`https://madeora.example/api/v1/dashboard${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

interface Stored {
  layout: unknown;
  revision: number;
  canEdit: boolean;
  canUndo?: boolean;
}

/** The database: `get_dashboard` answers `stored`, `save_dashboard` answers `outcome`. */
function database(stored: Stored | "not-member", outcome = "saved", templates: unknown[] = []) {
  state.rpc.mockImplementation((name) => {
    if (name === "get_dashboard") {
      if (stored === "not-member") {
        return { data: null, error: { code: "42501", message: "not permitted" } };
      }
      return {
        data: [
          {
            layout: stored.layout,
            revision: stored.revision,
            can_edit: stored.canEdit,
            can_undo: stored.canUndo ?? false,
            updated_at: null,
          },
        ],
        error: null,
      };
    }
    if (name === "save_dashboard" || name === "undo_dashboard_change") {
      return { data: [{ outcome, revision: 4 }], error: null };
    }
    if (name === "list_dashboard_templates") return { data: templates, error: null };
    throw new Error(`unexpected rpc ${name}`);
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

const personal = { kind: "personal" } as const;
const home = { kind: "home", homeId: HOME_ID } as const;

describe("PUT /api/v1/dashboard", () => {
  it("saves a valid personal layout at the expected revision", async () => {
    database({ layout: null, revision: 0, canEdit: true });
    const response = await PUT(
      request("", "PUT", { target: personal, layout: personalStarterLayout, expectedRevision: 0 }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: 4 });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(rpcArgs("save_dashboard")).toEqual({
      p_layout: personalStarterLayout,
      p_expected_revision: 0,
    });
  });

  it("saves a Home layout with the Home id for the database to check again", async () => {
    database({ layout: null, revision: 0, canEdit: true });
    const response = await PUT(
      request("", "PUT", { target: home, layout: homeStarterLayout, expectedRevision: 0 }),
    );
    expect(response.status).toBe(200);
    expect(rpcArgs("get_dashboard")).toEqual({ p_home_id: HOME_ID });
    expect(rpcArgs("save_dashboard")).toMatchObject({ p_home_id: HOME_ID });
  });

  it("refuses a Home layout from someone who may only view it, without saving", async () => {
    database({ layout: null, revision: 0, canEdit: false });
    const response = await PUT(
      request("", "PUT", { target: home, layout: homeStarterLayout, expectedRevision: 0 }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "not-permitted" });
    expect(rpcArgs("save_dashboard")).toBeUndefined();
  });

  it("answers 404 for a Home the person does not belong to (or a forged id)", async () => {
    database("not-member");
    const response = await PUT(
      request("", "PUT", {
        target: { kind: "home", homeId: OTHER_HOME },
        layout: homeStarterLayout,
        expectedRevision: 0,
      }),
    );
    expect(response.status).toBe(404);
  });

  it("answers 409 with the current revision when someone saved first", async () => {
    database({ layout: null, revision: 0, canEdit: true }, "conflict");
    const response = await PUT(
      request("", "PUT", { target: personal, layout: personalStarterLayout, expectedRevision: 0 }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict", revision: 4 });
  });

  it("refuses a widget that does not belong on that dashboard", async () => {
    database({ layout: null, revision: 0, canEdit: true });
    const withNotifications = addWidget(homeStarterLayout, {
      id: WIDGET_ID,
      type: "notifications",
      hidden: false,
      config: {},
    });
    const response = await PUT(
      request("", "PUT", { target: home, layout: withNotifications, expectedRevision: 0 }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid", fields: ["layout.surface"] });
  });

  it("refuses a Home widget bound to a Home the person is not in", async () => {
    database({ layout: null, revision: 0, canEdit: true });
    const bound = addWidget(personalStarterLayout, {
      id: WIDGET_ID,
      type: "home-members",
      hidden: false,
      config: {},
      source: { homeId: OTHER_HOME },
    });
    const response = await PUT(
      request("", "PUT", { target: personal, layout: bound, expectedRevision: 0 }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid", fields: ["layout.source"] });
  });

  it("keeps a widget for a Home the person left while it is already in their saved layout", async () => {
    const bound = addWidget(personalStarterLayout, {
      id: WIDGET_ID,
      type: "home-members",
      hidden: false,
      config: {},
      source: { homeId: OTHER_HOME },
    });
    database({ layout: bound, revision: 2, canEdit: true });
    const response = await PUT(
      request("", "PUT", { target: personal, layout: bound, expectedRevision: 2 }),
    );
    expect(response.status).toBe(200);
  });

  it("refuses unsafe requests before reading anything", async () => {
    database({ layout: null, revision: 0, canEdit: true });
    const crossSite = await PUT(
      request(
        "",
        "PUT",
        { target: personal, layout: personalStarterLayout, expectedRevision: 0 },
        { origin: "https://evil.example", host: "madeora.example" },
      ),
    );
    expect(crossSite.status).toBe(403);
    state.identity = null;
    const signedOut = await PUT(
      request("", "PUT", { target: personal, layout: personalStarterLayout, expectedRevision: 0 }),
    );
    expect(signedOut.status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses malformed bodies", async () => {
    state.identity = { userId: "user-a" };
    const response = await PUT(
      request("", "PUT", { target: personal, layout: personalStarterLayout, expectedRevision: -1 }),
    );
    expect(response.status).toBe(400);
  });
});

describe("POST /api/v1/dashboard/reset", () => {
  it("stores the starter layout and keeps the current one for Undo", async () => {
    const customized = addWidget(personalStarterLayout, {
      id: WIDGET_ID,
      type: "welcome",
      hidden: false,
      config: { showDate: false },
    });
    database({ layout: customized, revision: 3, canEdit: true });
    const response = await resetPost(
      request("/reset", "POST", { target: personal, expectedRevision: 3 }),
    );
    expect(response.status).toBe(200);
    expect(rpcArgs("save_dashboard")).toEqual({
      p_layout: personalStarterLayout,
      p_expected_revision: 3,
      p_previous: customized,
    });
  });

  it("refuses a reset of a Home dashboard by a viewer", async () => {
    database({ layout: null, revision: 0, canEdit: false });
    const response = await resetPost(
      request("/reset", "POST", { target: home, expectedRevision: 0 }),
    );
    expect(response.status).toBe(403);
  });
});

describe("POST /api/v1/dashboard/undo", () => {
  it("answers 409 when there is nothing to undo", async () => {
    database({ layout: null, revision: 0, canEdit: true }, "nothing_to_undo");
    const response = await undoPost(
      request("/undo", "POST", { target: home, expectedRevision: 1 }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "nothing-to-undo" });
    expect(rpcArgs("undo_dashboard_change")).toEqual({
      p_expected_revision: 1,
      p_home_id: HOME_ID,
    });
  });

  it("answers 403 when the database refuses the person", async () => {
    database({ layout: null, revision: 0, canEdit: true }, "not_permitted");
    const response = await undoPost(
      request("/undo", "POST", { target: home, expectedRevision: 1 }),
    );
    expect(response.status).toBe(403);
  });
});

describe("POST /api/v1/dashboard/apply-template", () => {
  function templateRow(kind: string, isMine: boolean, sharedHomeIds: string[], layout: unknown) {
    return {
      template_id: TEMPLATE_ID,
      name: "Morning",
      kind,
      layout,
      is_mine: isMine,
      shared_home_ids: sharedHomeIds,
      updated_at: "2026-10-16T08:00:00Z",
    };
  }

  it("applies a built-in starter with fresh widget ids and keeps the old layout for Undo", async () => {
    database({ layout: null, revision: 0, canEdit: true });
    const response = await applyPost(
      request("/apply-template", "POST", {
        target: personal,
        expectedRevision: 0,
        template: { builtIn: "starter-personal" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: 4, dropped: 0 });
    const saved = rpcArgs("save_dashboard");
    const layout = saved?.p_layout as { widgets: { id: string; type: string }[] };
    expect(layout.widgets.map((w) => w.type)).toEqual(
      personalStarterLayout.widgets.map((w) => w.type),
    );
    expect(layout.widgets.map((w) => w.id)).not.toEqual(
      personalStarterLayout.widgets.map((w) => w.id),
    );
    expect(saved?.p_previous).toEqual(personalStarterLayout);
  });

  it("refuses a built-in template of the other kind", async () => {
    database({ layout: null, revision: 0, canEdit: true });
    const response = await applyPost(
      request("/apply-template", "POST", {
        target: home,
        expectedRevision: 0,
        template: { builtIn: "starter-personal" },
      }),
    );
    expect(response.status).toBe(400);
  });

  it("applies a personal template shared into one of the person's Homes", async () => {
    database({ layout: null, revision: 0, canEdit: true }, "saved", [
      templateRow("personal", false, [HOME_ID], personalStarterLayout),
    ]);
    const response = await applyPost(
      request("/apply-template", "POST", {
        target: personal,
        expectedRevision: 0,
        template: { id: TEMPLATE_ID },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("refuses a Home template that was not shared into the target Home", async () => {
    database({ layout: null, revision: 0, canEdit: true }, "saved", [
      templateRow("home", false, [OTHER_HOME], homeStarterLayout),
    ]);
    const response = await applyPost(
      request("/apply-template", "POST", {
        target: home,
        expectedRevision: 0,
        template: { id: TEMPLATE_ID },
      }),
    );
    expect(response.status).toBe(404);
    expect(rpcArgs("save_dashboard")).toBeUndefined();
  });

  it("refuses an unknown template like one that is not theirs", async () => {
    database({ layout: null, revision: 0, canEdit: true }, "saved", []);
    const response = await applyPost(
      request("/apply-template", "POST", {
        target: personal,
        expectedRevision: 0,
        template: { id: TEMPLATE_ID },
      }),
    );
    expect(response.status).toBe(404);
  });
});
