import { register } from "./instrumentation";

describe("register", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("VERCEL_BRANCH_URL", "");
    vi.stubEnv("VERCEL_TARGET_ENV", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stops server start-up when a required variable is missing", async () => {
    vi.stubEnv("APP_ENV", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");

    await expect(register()).rejects.toThrow("APP_ENV (missing)");
  });

  it("starts when the configuration is valid", async () => {
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");

    await expect(register()).resolves.toBeUndefined();
  });

  it("fills the address of a Vercel preview before validating", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_BRANCH_URL", "madeora-git-feat-x-ward.vercel.app");
    vi.stubEnv("APP_ENV", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");

    await expect(register()).resolves.toBeUndefined();
    expect(process.env.APP_ENV).toBe("preview");
    expect(process.env.NEXT_PUBLIC_APP_URL).toBe("https://madeora-git-feat-x-ward.vercel.app");
  });

  it("still stops a Vercel production server that has no address", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_BRANCH_URL", "madeora-git-production-ward.vercel.app");
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");

    await expect(register()).rejects.toThrow("NEXT_PUBLIC_APP_URL (missing)");
  });
});
