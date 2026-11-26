import { afterEach, vi } from "vitest";

vi.mock("next/server", () => ({ connection: vi.fn(() => Promise.resolve()) }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("shell preview page", () => {
  it("is not served in production", async () => {
    vi.stubEnv("APP_ENV", "production");
    const { default: Page } = await import("./page");
    await expect(Page()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it.each(["development", "test", "preview", "staging"])("is served in %s", async (env) => {
    vi.stubEnv("APP_ENV", env);
    const { default: Page } = await import("./page");
    await expect(Page()).resolves.toBeTruthy();
  });
});
