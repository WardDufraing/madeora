import { POST } from "./route";

interface Identity {
  current: { userId: string } | null;
}
const identity = vi.hoisted((): Identity => ({ current: { userId: "user-a" } }));
const rpc = vi.hoisted(() => vi.fn());
const cookieSet = vi.hoisted(() => vi.fn());

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(identity.current),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () => Promise.resolve({ rpc }),
}));
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ set: cookieSet }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

function post(headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request("https://madeora.example/api/v1/me/trusted-device", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://madeora.example",
        host: "madeora.example",
        "user-agent": FIREFOX_LINUX,
        ...headers,
      },
      body: "{}",
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  identity.current = { userId: "user-a" };
  rpc.mockResolvedValue({ data: "2026-12-06T10:00:00Z", error: null });
});

describe("POST /api/v1/me/trusted-device", () => {
  it("trusts this browser and keeps the token only in an httpOnly cookie", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("trust_this_device", expect.any(Object));
    const args = rpc.mock.calls[0]?.[1] as Record<string, string>;
    expect(args).toMatchObject({ p_kind: "computer", p_browser: "firefox", p_platform: "linux" });
    expect(args.p_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [cookieName, token, options] = cookieSet.mock.calls[0] as [string, string, object];
    expect(cookieName).toMatch(/^madeora-trust-[0-9a-f]{16}$/);
    expect(cookieName).not.toContain("user-a");
    expect(token).toBe(args.p_token);
    expect(options).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      expires: new Date("2026-12-06T10:00:00Z"),
    });
    // The token is never sent back in the body.
    expect(JSON.stringify(await response.json())).not.toContain(token);
  });

  it("refuses a cross-site request before doing anything", async () => {
    const response = await post({ origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("refuses a signed-out request", async () => {
    identity.current = null;
    expect((await post()).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("sets no cookie when the database refuses (no recent second factor)", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    const response = await post();
    expect(response.status).toBe(403);
    expect(cookieSet).not.toHaveBeenCalled();
  });
});
