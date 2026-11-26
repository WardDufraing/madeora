import type { Mock } from "vitest";

import { addWidget, type DashboardLayout } from "@/dashboard/layout";
import { homeStarterLayout } from "@/dashboard/starter";
import { defaultConfig } from "@/dashboard/widgets";

import { PUT as save } from "./route";
import { GET as readDraft } from "./draft/route";
import { GET as readHistory } from "./history/route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const NEW_WIDGET = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0200";

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
const mine = { kind: "home", homeId: HOME_ID, view: "mine" } as const;

/** The shared default (revision 4, not editable by this member) and the member's view (if any). */
function database({
  viewLayout = null,
  viewRevision = 0,
}: { viewLayout?: DashboardLayout | null; viewRevision?: number } = {}) {
  state.rpc.mockImplementation((name, args) => {
    switch (name) {
      case "get_dashboard":
        return {
          data: [
            args.p_target === "mine"
              ? {
                  layout: viewLayout,
                  revision: viewRevision,
                  can_edit: true,
                  can_undo: false,
                  target: "mine",
                  has_override: viewLayout !== null,
                  has_draft: false,
                }
              : {
                  layout: homeStarterLayout,
                  revision: 4,
                  can_edit: false,
                  can_undo: false,
                  target: "default",
                  has_override: viewLayout !== null,
                  has_draft: false,
                },
          ],
          error: null,
        };
      case "save_dashboard":
        return { data: [{ outcome: "saved", revision: 1 }], error: null };
      case "get_dashboard_draft":
        return { data: [], error: null };
      case "list_dashboard_versions":
        return { data: [], error: null };
      default:
        return { data: null, error: { code: "XX000", message: "unexpected" } };
    }
  });
}

function put(body: unknown): Request {
  return new Request("https://madeora.example/api/v1/dashboard", {
    method: "PUT",
    headers: { "content-type": "application/json", ...sameOrigin },
    body: JSON.stringify(body),
  });
}
function get(path: string): Request {
  return new Request(`https://madeora.example/api/v1/dashboard/${path}`);
}
function calls(name: string) {
  return state.rpc.mock.calls.filter(([called]) => called === name).map(([, args]) => args);
}

const edited = addWidget(homeStarterLayout, {
  id: NEW_WIDGET,
  type: "home-members",
  hidden: false,
  config: defaultConfig("home-members"),
});

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
});

describe("saving My Home view", () => {
  it("starts a new view from the shared default the person saw, naming the view target", async () => {
    database();
    const response = await save(put({ target: mine, layout: edited, expectedRevision: 0 }));
    expect(response.status).toBe(200);
    const [args] = calls("save_dashboard");
    expect(args).toMatchObject({ p_home_id: HOME_ID, p_target: "mine", p_expected_revision: 0 });
    // What the person looked at, so the database knows which shared widgets they have seen.
    expect(args?.p_previous).toBeDefined();
  });

  it("does not resend the previous layout once the view exists", async () => {
    database({ viewLayout: homeStarterLayout, viewRevision: 3 });
    const response = await save(put({ target: mine, layout: edited, expectedRevision: 3 }));
    expect(response.status).toBe(200);
    const [args] = calls("save_dashboard");
    expect(args).toMatchObject({ p_target: "mine", p_expected_revision: 3 });
    expect(args).not.toHaveProperty("p_previous");
  });

  it("refuses a member who may not edit the shared default when they name no view", async () => {
    database();
    const response = await save(
      put({ target: { kind: "home", homeId: HOME_ID }, layout: edited, expectedRevision: 4 }),
    );
    expect(response.status).toBe(403);
    expect(calls("save_dashboard")).toHaveLength(0);
  });

  it("refuses an unknown view", async () => {
    database();
    const response = await save(
      put({
        target: { kind: "home", homeId: HOME_ID, view: "all" },
        layout: edited,
        expectedRevision: 0,
      }),
    );
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("drafts and history of My Home view", () => {
  it("reads the draft of the view, never of the shared default, when asked for it", async () => {
    database();
    const response = await readDraft(get(`draft?homeId=${HOME_ID}&view=mine`));
    expect(response.status).toBe(200);
    expect(calls("get_dashboard_draft")).toEqual([{ p_home_id: HOME_ID, p_target: "mine" }]);
  });

  it("reads the shared default's draft when no view is named", async () => {
    database();
    await readDraft(get(`draft?homeId=${HOME_ID}`));
    expect(calls("get_dashboard_draft")).toEqual([{ p_home_id: HOME_ID }]);
  });

  it("lists the history of the view when asked for it", async () => {
    database();
    const response = await readHistory(get(`history?homeId=${HOME_ID}&view=mine`));
    expect(response.status).toBe(200);
    expect(calls("list_dashboard_versions")).toEqual([{ p_home_id: HOME_ID, p_target: "mine" }]);
  });

  it("refuses an unknown view or a view without a Home", async () => {
    database();
    for (const query of [`homeId=${HOME_ID}&view=all`, "view=mine"]) {
      expect((await readDraft(get(`draft?${query}`))).status).toBe(400);
      expect((await readHistory(get(`history?${query}`))).status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
