import { POST } from "./route";

const signOut = vi.fn();
const rpc = vi.fn();
const authState = vi.hoisted((): { kind: string } => ({ kind: "signed-in" }));
vi.mock("@/auth/identity", () => ({
  getAuthState: () => Promise.resolve({ kind: authState.kind }),
}));
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
  createSupabaseServerClient: () => Promise.resolve({ auth: { signOut }, rpc }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

function post(headers: Record<string, string>) {
  return POST(new Request("http://localhost:3000/auth/sign-out", { method: "POST", headers }));
}

beforeEach(() => {
  authState.kind = "signed-in";
  rpc.mockReset().mockResolvedValue({ data: null, error: null });
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

  it.each([
    [
      "then=switch&account=6F2C1F0E-1D7A-4B8E-9C55-2B2F6B0A0F01",
      "/sign-in?status=switched&account=6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01",
    ],
    ["then=switch&account=not-an-id", "/sign-in?status=switched"],
    ["then=switch", "/sign-in?status=switched"],
    ["then=accounts", "/accounts?status=removed"],
    ["then=elsewhere", "/sign-in?status=signed-out"],
  ])("after switching (S38), %s goes to %s", async (body, location) => {
    const response = await POST(
      new Request("http://localhost:3000/auth/sign-out", {
        method: "POST",
        headers: {
          origin: "https://madeora.example",
          host: "madeora.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      }),
    );
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.headers.get("location")).toBe(location);
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

  it("ends a child's registered session in the database before signing out (S42)", async () => {
    authState.kind = "child";
    const response = await POST(
      new Request("http://localhost:3000/auth/sign-out", {
        method: "POST",
        headers: {
          origin: "https://madeora.example",
          host: "madeora.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "then=household",
      }),
    );
    expect(rpc).toHaveBeenCalledWith("child_end_session");
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.headers.get("location")).toBe("/household");
  });

  it("does not call the child function for an adult, and then=child goes to child sign-in", async () => {
    const response = await POST(
      new Request("http://localhost:3000/auth/sign-out", {
        method: "POST",
        headers: {
          origin: "https://madeora.example",
          host: "madeora.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "then=child",
      }),
    );
    expect(rpc).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe("/sign-in/child?status=signed-out");
  });
});
