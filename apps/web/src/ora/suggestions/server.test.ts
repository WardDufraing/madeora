import { claimTeaser, dismissSuggestion, loadSuggestions } from "./server";

interface State {
  overview: unknown;
  dismissed: { kind: string; situation: string }[];
  readError: { code: string } | null;
  upserts: unknown[];
  upsertError: { code: string } | null;
  filters: [string, string][];
  claim: { data: boolean | null; error: { code: string } | null };
  claims: unknown[];
}
const state = vi.hoisted((): State => ({
  overview: {
    status: "ok",
    overview: {
      today: "2026-11-16",
      incomplete: false,
      days: [{ date: "2026-11-16", timed: [{}], untimed: [{}, {}] }],
    },
  },
  dismissed: [],
  readError: null,
  upserts: [],
  upsertError: null,
  filters: [],
  claim: { data: true, error: null },
  claims: [],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/ora/overview/server", () => ({ loadOverview: () => Promise.resolve(state.overview) }));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      from: () => ({
        select: () => ({
          eq: (column: string, value: string) => {
            state.filters.push([column, value]);
            return Promise.resolve({ data: state.dismissed, error: state.readError });
          },
        }),
        upsert: (row: unknown) => {
          state.upserts.push(row);
          return Promise.resolve({ error: state.upsertError });
        },
      }),
      rpc: (_fn: string, args: unknown) => {
        state.claims.push(args);
        return Promise.resolve(state.claim);
      },
    }),
}));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const personal = { home: null };
const inHome = {
  home: {
    id: HOME,
    membership: { homeId: HOME, role: "member" as const, grantedCapabilities: new Set<never>() },
  },
};

beforeEach(() => {
  state.dismissed = [];
  state.readError = null;
  state.upserts = [];
  state.upsertError = null;
  state.filters = [];
  state.claim = { data: true, error: null };
  state.claims = [];
  state.overview = {
    status: "ok",
    overview: {
      today: "2026-11-16",
      incomplete: false,
      days: [{ date: "2026-11-16", timed: [{}], untimed: [{}, {}] }],
    },
  };
});

describe("loadSuggestions", () => {
  it("suggests today's overview with the number of open things", async () => {
    expect(await loadSuggestions(personal)).toEqual({
      status: "ok",
      today: "2026-11-16",
      suggestions: [{ kind: "today-overview", situation: "2026-11-16", count: 3 }],
    });
    expect(state.filters).toEqual([["scope", "personal"]]);
  });

  it("looks only at the Home it is asked about", async () => {
    await loadSuggestions(inHome);
    expect(state.filters).toEqual([["scope", HOME]]);
  });

  it("says nothing on an empty day or from an incomplete reading", async () => {
    state.overview = {
      status: "ok",
      overview: {
        today: "2026-11-16",
        incomplete: false,
        days: [{ date: "2026-11-16", timed: [], untimed: [] }],
      },
    };
    expect(await loadSuggestions(personal)).toMatchObject({ suggestions: [] });
    state.overview = {
      status: "ok",
      overview: {
        today: "2026-11-16",
        incomplete: true,
        days: [{ date: "2026-11-16", timed: [{}], untimed: [] }],
      },
    };
    expect(await loadSuggestions(personal)).toMatchObject({ suggestions: [] });
  });

  it("stays quiet for a dismissed situation but offers it again for a new day", async () => {
    state.dismissed = [{ kind: "today-overview", situation: "2026-11-16" }];
    expect(await loadSuggestions(personal)).toMatchObject({ suggestions: [] });
    state.dismissed = [{ kind: "today-overview", situation: "2026-11-15" }];
    expect(await loadSuggestions(personal)).toMatchObject({
      suggestions: [{ kind: "today-overview" }],
    });
  });

  it("is unavailable when a source cannot be read", async () => {
    state.overview = { status: "unavailable" };
    expect(await loadSuggestions(personal)).toEqual({ status: "unavailable" });
    state.overview = {
      status: "ok",
      overview: { today: "2026-11-16", incomplete: false, days: [] },
    };
    state.readError = { code: "XX000" };
    expect(await loadSuggestions(personal)).toEqual({ status: "unavailable" });
  });
});

describe("dismissSuggestion", () => {
  it("remembers the dismissal for this place only", async () => {
    expect(await dismissSuggestion(inHome, "today-overview", "2026-11-16")).toBe("ok");
    expect(state.upserts[0]).toMatchObject({
      scope: HOME,
      home_id: HOME,
      kind: "today-overview",
      situation: "2026-11-16",
    });
    await dismissSuggestion(personal, "today-overview", "2026-11-16");
    expect(state.upserts[1]).toMatchObject({ scope: "personal", home_id: null });
  });

  it("maps a refusal and a failure", async () => {
    state.upsertError = { code: "42501" };
    expect(await dismissSuggestion(inHome, "today-overview", "x")).toBe("forbidden");
    state.upsertError = { code: "XX000" };
    expect(await dismissSuggestion(inHome, "today-overview", "x")).toBe("failed");
  });
});

describe("claimTeaser", () => {
  it("returns the suggestion when the database grants today's teaser", async () => {
    const result = await claimTeaser(personal);
    expect(result).toMatchObject({ status: "ok", teaser: { kind: "today-overview" } });
    expect(state.claims).toEqual([{ p_today: "2026-11-16" }]);
  });

  it("returns none, and does not claim, when there is nothing to say", async () => {
    state.dismissed = [{ kind: "today-overview", situation: "2026-11-16" }];
    expect(await claimTeaser(personal)).toEqual({ status: "ok", teaser: null });
    expect(state.claims).toEqual([]);
  });

  it("returns none when the daily teaser was already used or teasers are muted", async () => {
    state.claim = { data: false, error: null };
    expect(await claimTeaser(personal)).toEqual({ status: "ok", teaser: null });
  });

  it("is unavailable when the claim fails", async () => {
    state.claim = { data: null, error: { code: "XX000" } };
    expect(await claimTeaser(personal)).toEqual({ status: "unavailable" });
  });
});
