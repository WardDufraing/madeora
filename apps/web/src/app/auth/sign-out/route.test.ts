import { POST } from "./route";

const signOut = vi.fn();
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
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sign-in?status=signed-out");
  });
});
