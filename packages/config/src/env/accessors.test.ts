import { afterEach, describe, expect, it, vi } from "vitest";

import { EnvValidationError } from "./core.ts";
import { getPublicEnv } from "./public.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("getServerEnv", () => {
  it("validates process.env once and reuses the result", async () => {
    vi.stubEnv("APP_ENV", "staging");
    const { getServerEnv } = await import("./server.ts");
    expect(getServerEnv()).toEqual({ APP_ENV: "staging" });

    vi.stubEnv("APP_ENV", "production");
    expect(getServerEnv()).toEqual({ APP_ENV: "staging" });
  });

  it("names an invalid variable without its value", async () => {
    vi.stubEnv("APP_ENV", "sk_live_should-never-be-printed");
    const { getServerEnv } = await import("./server.ts");
    const { EnvValidationError: FreshError } = await import("./core.ts");
    let message = "";
    try {
      getServerEnv();
    } catch (error) {
      expect(error).toBeInstanceOf(FreshError);
      message = String(error);
    }
    expect(message).toContain("APP_ENV (invalid)");
    expect(message).not.toContain("sk_live");
  });

  it("validates an explicit source without caching it", async () => {
    const { getServerEnv } = await import("./server.ts");
    expect(getServerEnv({ APP_ENV: "test" })).toEqual({ APP_ENV: "test" });
    expect(() => getServerEnv({})).toThrow("APP_ENV (missing)");
  });
});

describe("getPublicEnv", () => {
  it("reads NEXT_PUBLIC_ values from process.env", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://madeora.test");
    expect(getPublicEnv()).toEqual({ NEXT_PUBLIC_APP_URL: "https://madeora.test" });
  });

  it("names a missing public variable", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(() => getPublicEnv()).toThrow(EnvValidationError);
    expect(() => getPublicEnv()).toThrow("NEXT_PUBLIC_APP_URL (missing)");
  });

  it("validates an explicit source", () => {
    expect(() => getPublicEnv({ NEXT_PUBLIC_APP_URL: "ftp://example.test" })).toThrow(
      "NEXT_PUBLIC_APP_URL (invalid)",
    );
  });
});
