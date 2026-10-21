import type { Mock } from "vitest";

import { addWidget } from "@/dashboard/layout";
import { personalStarterLayout } from "@/dashboard/starter";

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
    const answer = map[name];
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
  it("lists visible templates with their widget types, never their layouts", async () => {
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
          widgets: ["welcome", "quick-actions", "notifications", "tasks"],
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
    expect(layout.widgets).toHaveLength(4);
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
