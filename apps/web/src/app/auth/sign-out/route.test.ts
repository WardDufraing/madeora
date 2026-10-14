import { POST } from "./route";

const signOut = vi.fn();
const cookieStore = {
  getAll: vi.fn(() => [
    { name: "sb-127-auth-token.0" },
    { name: "sb-127-auth-token.1" },
    { name: "theme" },
  ]),
  delete: vi.fn(),
};
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(cookieStore) }));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () => Promise.resolve({ auth: { signOut } }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

function post(headers: Record<string, string>) {
  return POST(new Request("http://localhost:3000/auth/sign-out", { method: "POST", headers }));
}

beforeEach(() => {
  signOut.mockReset().mockResolvedValue({ error: null });
  cookieStore.delete.mockClear();
});

describe("POST /auth/sign-out", () => {
  it.each([[{ origin: "https://evil.example" }], [{ origin: "null" }], [{}]])(
    "refuses %j without touching the session",
    async (headers) => {
      const response = await post({ host: "madeora.example", ...headers });
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(signOut).not.toHaveBeenCalled();
    },
  );

  it("signs this browser out and returns to sign-in on the same origin", async () => {
    const response = await post({ origin: "https://madeora.example", host: "madeora.example" });
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(cookieStore.delete).not.toHaveBeenCalled();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sign-in?status=signed-out");
  });

  it("still deletes this browser's session cookies when Supabase Auth cannot be reached", async () => {
    signOut.mockResolvedValue({ error: new Error("fetch failed") });
    const response = await post({ origin: "https://madeora.example", host: "madeora.example" });
    expect(cookieStore.delete.mock.calls).toEqual([
      ["sb-127-auth-token.0"],
      ["sb-127-auth-token.1"],
    ]);
    expect(response.status).toBe(303);
  });
});
