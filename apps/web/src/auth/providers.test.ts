import { isGoogleSignInEnabled } from "./providers";

vi.mock("server-only", () => ({}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.test",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  }),
}));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const answer = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("isGoogleSignInEnabled", () => {
  it("asks Supabase Auth's public settings with the publishable key", async () => {
    fetchMock.mockReturnValue(answer({ external: { email: true, google: true } }));
    await expect(isGoogleSignInEnabled()).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toEqual(new URL("https://project.supabase.test/auth/v1/settings"));
    expect(init?.headers).toEqual({ apikey: "sb_publishable_test" });
  });

  it.each([
    ["switched off", () => answer({ external: { google: false } })],
    ["not listed", () => answer({ external: { email: true } })],
    ["a malformed answer", () => answer({ external: { google: "yes" } })],
    ["an error status", () => answer({ external: { google: true } }, 500)],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
  ])("treats %s as off", async (_case, response) => {
    fetchMock.mockImplementation(response);
    await expect(isGoogleSignInEnabled()).resolves.toBe(false);
  });
});
