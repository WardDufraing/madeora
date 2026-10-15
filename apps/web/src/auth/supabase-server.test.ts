import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  header: null as string | null,
  options: undefined as { global?: { headers?: Record<string, string> } } | undefined,
}));

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ getAll: () => [], set: () => undefined }),
  headers: () =>
    Promise.resolve(new Headers(state.header ? { "x-correlation-id": state.header } : {})),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic",
    NEXT_PUBLIC_APP_URL: "https://madeora.example",
  }),
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, options: typeof state.options) => {
    state.options = options;
    return {};
  },
}));

const { createSupabaseServerClient } = await import("./supabase-server");

describe("createSupabaseServerClient", () => {
  it("forwards the request's correlation ID to the database", async () => {
    state.header = "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f";
    await createSupabaseServerClient();
    expect(state.options?.global?.headers).toEqual({ "x-correlation-id": state.header });
  });

  it("forwards nothing that is not a correlation ID", async () => {
    state.header = "not-an-id x-evil: 1";
    await createSupabaseServerClient();
    expect(state.options?.global).toBeUndefined();
    state.header = null;
    await createSupabaseServerClient();
    expect(state.options?.global).toBeUndefined();
  });
});
