import { register } from "./instrumentation";

describe("register", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
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
});
