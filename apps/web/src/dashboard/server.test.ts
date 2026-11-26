import type { Mock } from "vitest";

import { loadDashboard, loadSuggestions } from "./server";
import { homeStarterLayout } from "./starter";

interface State {
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ rpc: vi.fn() }));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const WIDGET_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0200";

vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args: Record<string, unknown>) => Promise.resolve(state.rpc(name, args)),
    }),
}));
vi.mock("@/homes/server", () => ({
  listMyHomes: () => Promise.resolve({ status: "ok", homes: [] }),
}));

beforeEach(() => {
  state.rpc.mockReset();
});

function row(target: "default" | "mine", layout: unknown, extra: Record<string, unknown> = {}) {
  return {
    layout,
    revision: layout === null ? 0 : 4,
    can_edit: target === "mine",
    can_undo: false,
    updated_at: null,
    target,
    has_override: false,
    has_draft: false,
    ...extra,
  };
}

describe("loadDashboard on a Home", () => {
  it("shows the shared default at revision 0 for a view that does not exist yet", async () => {
    state.rpc.mockImplementation((_name, args) => ({
      data: [args.p_target === "mine" ? row("mine", null) : row("default", homeStarterLayout)],
      error: null,
    }));
    const result = await loadDashboard("home", HOME_ID, "mine");
    if (result.status !== "ok") throw new Error("expected a dashboard");
    expect(result.dashboard).toMatchObject({
      answered: "mine",
      hasOverride: false,
      revision: 0,
      canEdit: true,
      canUndo: false,
    });
    expect(result.dashboard.layout.widgets.map((w) => w.type)).toEqual(
      homeStarterLayout.widgets.map((w) => w.type),
    );
  });

  it("reads the person's own view with its revision when they have one", async () => {
    state.rpc.mockReturnValue({
      data: [row("mine", homeStarterLayout, { has_override: true })],
      error: null,
    });
    const result = await loadDashboard("home", HOME_ID, "effective");
    if (result.status !== "ok") throw new Error("expected a dashboard");
    expect(result.dashboard).toMatchObject({ answered: "mine", hasOverride: true, revision: 4 });
    expect(state.rpc).toHaveBeenCalledWith("get_dashboard", {
      p_home_id: HOME_ID,
      p_target: "effective",
    });
  });

  it("keeps the arguments the shared default and the personal dashboard always had", async () => {
    state.rpc.mockReturnValue({ data: [row("default", homeStarterLayout)], error: null });
    await loadDashboard("home", HOME_ID);
    expect(state.rpc).toHaveBeenCalledWith("get_dashboard", { p_home_id: HOME_ID });
    state.rpc.mockClear();
    await loadDashboard("personal", null);
    expect(state.rpc).toHaveBeenCalledWith("get_dashboard", {});
  });

  it("is not-found for a Home the person does not belong to", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not permitted" } });
    expect(await loadDashboard("home", HOME_ID, "mine")).toEqual({ status: "not-found" });
  });
});

describe("loadSuggestions", () => {
  const widget = { id: WIDGET_ID, type: "home-members", hidden: false, config: {} };

  it("returns the shared widgets the database offers, read like any saved layout", async () => {
    state.rpc.mockReturnValue({ data: [{ widget_id: WIDGET_ID, widget }], error: null });
    const result = await loadSuggestions(HOME_ID);
    expect(state.rpc).toHaveBeenCalledWith("list_dashboard_suggestions", { p_home_id: HOME_ID });
    if (result.status !== "ok") throw new Error("expected suggestions");
    expect(result.suggestions.map((s) => s.widgetId)).toEqual([WIDGET_ID]);
    expect(result.suggestions[0]?.widget.type).toBe("home-members");
  });

  it("leaves out a widget type this client does not know and a malformed entry", async () => {
    state.rpc.mockReturnValue({
      data: [
        { widget_id: WIDGET_ID, widget: { ...widget, type: "from-the-future" } },
        { widget_id: WIDGET_ID, widget: null },
        { widget_id: WIDGET_ID, widget: { id: "nope" } },
      ],
      error: null,
    });
    expect(await loadSuggestions(HOME_ID)).toEqual({ status: "ok", suggestions: [] });
  });

  it("is unavailable, never an exception, when the database fails", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "XX000", message: "boom" } });
    expect(await loadSuggestions(HOME_ID)).toEqual({ status: "unavailable" });
  });
});
