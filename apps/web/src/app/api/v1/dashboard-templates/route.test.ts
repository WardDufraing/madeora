import type { Mock } from "vitest";

import { addWidget } from "@/dashboard/layout";
import { homeStarterLayout } from "@/dashboard/starter";
import { legacyPersonalStarterLayout as personalStarterLayout } from "@/dashboard/starter.fixture";
import { defaultConfig } from "@/dashboard/widgets";

import { POST as duplicate } from "./[templateId]/duplicate/route";
import { DELETE as deleteTemplate, PATCH } from "./[templateId]/route";
import { DELETE as unshare, PUT as share } from "./[templateId]/shares/[homeId]/route";
import { GET, POST } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const TEMPLATE_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0100";
const WIDGET_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0200";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/homes/server", () => ({
  listMyHomes: () => Promise.resolve({ status: "ok", homes: [] }),
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
const base = "https://madeora.example/api/v1/dashboard-templates";

function send(path: string, method: string, body: unknown): Request {
  return new Request(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...sameOrigin },
    body: JSON.stringify(body),
  });
}

function answers(map: Record<string, { data: unknown; error?: unknown }>) {
  state.rpc.mockImplementation((name) => {
    // The name check (UX2c) reads the visible templates; none unless a test says otherwise.
    const answer = map[name] ?? (name === "list_dashboard_templates" ? { data: [] } : undefined);
    if (!answer) throw new Error(`unexpected rpc ${name}`);
    return { data: answer.data, error: answer.error ?? null };
  });
}

function rpcArgs(name: string): Record<string, unknown> | undefined {
  return state.rpc.mock.calls.find(([called]) => called === name)?.[1];
}

const templateParams = { params: Promise.resolve({ templateId: TEMPLATE_ID }) };
const shareParams = { params: Promise.resolve({ templateId: TEMPLATE_ID, homeId: HOME_ID }) };

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /api/v1/dashboard-templates", () => {
  it("lists visible templates with their widget types and arrangement, never settings", async () => {
    answers({
      list_dashboard_templates: {
        data: [
          {
            template_id: TEMPLATE_ID,
            name: "Morning",
            kind: "personal",
            layout: personalStarterLayout,
            is_mine: true,
            shared_home_ids: [HOME_ID],
            updated_at: "2026-10-16T08:00:00Z",
          },
        ],
      },
    });
    const response = await GET(new Request(base));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      templates: [
        {
          id: TEMPLATE_ID,
          name: "Morning",
          kind: "personal",
          isMine: true,
          sharedHomeIds: [HOME_ID],
          widgets: ["welcome", "quick-actions", "notifications", "tasks", "upcoming-events"],
          preview: {
            widgets: personalStarterLayout.widgets.map(({ id, type, hidden }) => ({
              id,
              type,
              hidden,
            })),
            placements: personalStarterLayout.placements,
          },
        },
      ],
    });
  });

  it("answers 404 for a Home the person is not in, and 400 for unknown parameters", async () => {
    answers({
      list_dashboard_templates: { data: null, error: { code: "42501", message: "not permitted" } },
    });
    expect((await GET(new Request(`${base}?homeId=${HOME_ID}`))).status).toBe(404);
    expect((await GET(new Request(`${base}?homeId=nope`))).status).toBe(400);
    expect((await GET(new Request(`${base}?other=1`))).status).toBe(400);
  });

  it("answers 401 when signed out", async () => {
    state.identity = null;
    expect((await GET(new Request(base))).status).toBe(401);
  });
});

describe("POST /api/v1/dashboard-templates", () => {
  it("saves a copy of the dashboard without Home-bound widgets and says how many were left out", async () => {
    const bound = addWidget(personalStarterLayout, {
      id: WIDGET_ID,
      type: "home-members",
      hidden: false,
      config: {},
      source: { homeId: HOME_ID },
    });
    answers({
      get_dashboard: {
        data: [{ layout: bound, revision: 2, can_edit: true, can_undo: false, updated_at: null }],
      },
      create_dashboard_template: { data: [{ outcome: "created", template_id: TEMPLATE_ID }] },
    });
    const response = await POST(
      send("", "POST", { name: " Morning ", from: { kind: "personal" } }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: TEMPLATE_ID, dropped: 1 });
    const args = rpcArgs("create_dashboard_template");
    expect(args?.p_name).toBe("Morning");
    expect(args?.p_kind).toBe("personal");
    const layout = args?.p_layout as { widgets: { source?: unknown }[] };
    expect(layout.widgets).toHaveLength(5);
    expect(layout.widgets.some((w) => w.source)).toBe(false);
  });

  it("answers 409 at the template limit", async () => {
    answers({
      get_dashboard: {
        data: [{ layout: null, revision: 0, can_edit: true, can_undo: false, updated_at: null }],
      },
      create_dashboard_template: { data: [{ outcome: "limit_reached", template_id: null }] },
    });
    const response = await POST(send("", "POST", { name: "One more", from: { kind: "personal" } }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "limit-reached" });
  });

  it("refuses names that are empty, too long or contain control characters", async () => {
    for (const name of ["   ", "x".repeat(81), "bad\u0007name"]) {
      const response = await POST(send("", "POST", { name, from: { kind: "personal" } }));
      expect(response.status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("PATCH and DELETE /api/v1/dashboard-templates/{id}", () => {
  it("renames the person's own template, and answers 404 for anyone else's", async () => {
    answers({ rename_dashboard_template: { data: "ok" } });
    expect(
      (await PATCH(send(`/${TEMPLATE_ID}`, "PATCH", { name: "Evening" }), templateParams)).status,
    ).toBe(200);
    answers({ rename_dashboard_template: { data: "not_found" } });
    expect(
      (await PATCH(send(`/${TEMPLATE_ID}`, "PATCH", { name: "Evening" }), templateParams)).status,
    ).toBe(404);
  });

  it("moves the template to the trash and answers its trash entry", async () => {
    answers({ delete_dashboard_template: { data: WIDGET_ID } });
    const response = await deleteTemplate(send(`/${TEMPLATE_ID}`, "DELETE", {}), templateParams);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ trashEntryId: WIDGET_ID });
    answers({ delete_dashboard_template: { data: null } });
    expect(
      (await deleteTemplate(send(`/${TEMPLATE_ID}`, "DELETE", {}), templateParams)).status,
    ).toBe(404);
  });

  it("answers 404 for a malformed template id without asking the database", async () => {
    const response = await PATCH(send("/nope", "PATCH", { name: "Evening" }), {
      params: Promise.resolve({ templateId: "nope" }),
    });
    expect(response.status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("PUT and DELETE /api/v1/dashboard-templates/{id}/shares/{homeId}", () => {
  it("maps the database's share outcomes", async () => {
    const path = `/${TEMPLATE_ID}/shares/${HOME_ID}`;
    for (const [outcome, status] of [
      ["shared", 200],
      ["unchanged", 200],
      ["not_permitted", 403],
      ["not_found", 404],
    ] as const) {
      answers({ share_dashboard_template: { data: outcome } });
      expect((await share(send(path, "PUT", {}), shareParams)).status).toBe(status);
    }
    expect(rpcArgs("share_dashboard_template")).toEqual({
      p_template_id: TEMPLATE_ID,
      p_home_id: HOME_ID,
    });
  });

  it("stops a share, and answers 404 when there was none to stop", async () => {
    const path = `/${TEMPLATE_ID}/shares/${HOME_ID}`;
    answers({ unshare_dashboard_template: { data: "removed" } });
    expect((await unshare(send(path, "DELETE", {}), shareParams)).status).toBe(200);
    answers({ unshare_dashboard_template: { data: "not_found" } });
    expect((await unshare(send(path, "DELETE", {}), shareParams)).status).toBe(404);
  });

  it("refuses a body with extra fields", async () => {
    const response = await share(
      send(`/${TEMPLATE_ID}/shares/${HOME_ID}`, "PUT", { force: true }),
      shareParams,
    );
    expect(response.status).toBe(400);
  });
});

describe("POST /api/v1/dashboard-templates/:id/duplicate", () => {
  const SHARED_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0101";
  const visible = {
    data: [
      {
        template_id: SHARED_ID,
        name: "Weekend",
        kind: "home",
        layout: addWidget(homeStarterLayout, {
          id: WIDGET_ID,
          type: "tasks",
          hidden: false,
          config: defaultConfig("tasks"),
        }),
        is_mine: false,
        shared_home_ids: [HOME_ID],
        updated_at: "2026-10-16T08:00:00Z",
      },
    ],
  };
  const params = (templateId: string) => ({ params: Promise.resolve({ templateId }) });

  it("copies a visible template, even one shared by someone else, as the person's own", async () => {
    answers({
      list_dashboard_templates: visible,
      create_dashboard_template: { data: [{ outcome: "created", template_id: TEMPLATE_ID }] },
    });
    const response = await duplicate(
      send(`/${SHARED_ID}/duplicate`, "POST", { name: "Weekend (copy)" }),
      params(SHARED_ID),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: TEMPLATE_ID, dropped: 0 });
    const args = rpcArgs("create_dashboard_template");
    expect(args?.p_name).toBe("Weekend (copy)");
    expect(args?.p_kind).toBe("home");
    // New widget ids: the copy never shares ids with the original.
    const layout = args?.p_layout as { widgets: { id: string }[] };
    expect(layout.widgets.map((w) => w.id)).not.toContain(WIDGET_ID);
    expect(layout.widgets).toHaveLength(homeStarterLayout.widgets.length + 1);
  });

  it("answers 404 for a template the person may not see", async () => {
    answers({ list_dashboard_templates: visible });
    const response = await duplicate(
      send(`/${TEMPLATE_ID}/duplicate`, "POST", { name: "Copy" }),
      params(TEMPLATE_ID),
    );
    expect(response.status).toBe(404);
    expect(rpcArgs("create_dashboard_template")).toBeUndefined();
    expect(
      (await duplicate(send("/nope/duplicate", "POST", { name: "Copy" }), params("nope"))).status,
    ).toBe(404);
  });

  it("answers 409 at the template limit and 400 for a bad name", async () => {
    answers({
      list_dashboard_templates: visible,
      create_dashboard_template: { data: [{ outcome: "limit_reached", template_id: null }] },
    });
    const response = await duplicate(
      send(`/${SHARED_ID}/duplicate`, "POST", { name: "Copy" }),
      params(SHARED_ID),
    );
    expect(response.status).toBe(409);
    expect(
      (await duplicate(send(`/${SHARED_ID}/duplicate`, "POST", { name: " " }), params(SHARED_ID)))
        .status,
    ).toBe(400);
  });
});

describe("template names (UX2c, decision 31)", () => {
  const own = {
    data: [
      {
        template_id: TEMPLATE_ID,
        name: "Morning",
        kind: "home",
        layout: homeStarterLayout,
        is_mine: true,
        shared_home_ids: [],
        updated_at: "2026-10-16T08:00:00Z",
      },
    ],
  };

  it("refuses a new template under a name of another own template, of either kind", async () => {
    answers({
      list_dashboard_templates: own,
      get_dashboard: {
        data: [{ layout: null, revision: 0, can_edit: true, can_undo: false, updated_at: null }],
      },
    });
    const response = await POST(
      send("", "POST", { name: " morning ", from: { kind: "personal" } }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "name-taken" });
    expect(rpcArgs("create_dashboard_template")).toBeUndefined();
  });

  it("lets a template keep its own name on rename, but not take another's", async () => {
    const other = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0109";
    answers({ list_dashboard_templates: own, rename_dashboard_template: { data: "ok" } });
    expect(
      (await PATCH(send(`/${TEMPLATE_ID}`, "PATCH", { name: "MORNING" }), templateParams)).status,
    ).toBe(200);
    const refused = await PATCH(send(`/${other}`, "PATCH", { name: "Morning" }), {
      params: Promise.resolve({ templateId: other }),
    });
    expect(refused.status).toBe(409);
  });

  it("refuses a duplicate under a taken name, and cross-site or signed-out requests", async () => {
    answers({ list_dashboard_templates: own });
    const params = { params: Promise.resolve({ templateId: TEMPLATE_ID }) };
    expect(
      (await duplicate(send(`/${TEMPLATE_ID}/duplicate`, "POST", { name: "Morning" }), params))
        .status,
    ).toBe(409);
    const crossSite = new Request(`${base}/${TEMPLATE_ID}/duplicate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        host: "madeora.example",
      },
      body: JSON.stringify({ name: "Copy" }),
    });
    expect((await duplicate(crossSite, params)).status).toBe(403);
    expect(
      (
        await duplicate(
          send(`/${TEMPLATE_ID}/duplicate`, "POST", { name: "Copy", extra: 1 }),
          params,
        )
      ).status,
    ).toBe(400);
    state.identity = null;
    expect(
      (await duplicate(send(`/${TEMPLATE_ID}/duplicate`, "POST", { name: "Copy" }), params)).status,
    ).toBe(401);
    expect(rpcArgs("create_dashboard_template")).toBeUndefined();
  });
});
