import { describe, expect, it } from "vitest";

import { EnvValidationError, parseEnv, publicEnvSchema, serverEnvSchema } from "./index";

function captureError(fn: () => unknown): EnvValidationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error("expected parseEnv to throw");
}

describe("parseEnv", () => {
  it("returns typed values when every required variable is valid", () => {
    expect(parseEnv(serverEnvSchema, { APP_ENV: "development" })).toEqual({
      APP_ENV: "development",
    });
    expect(parseEnv(publicEnvSchema, { NEXT_PUBLIC_APP_URL: "http://localhost:3000" })).toEqual({
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    });
  });

  it("names a missing variable", () => {
    const error = captureError(() => parseEnv(serverEnvSchema, {}));
    expect(error.problems).toEqual([{ variable: "APP_ENV", reason: "missing" }]);
    expect(error.message).toContain("APP_ENV (missing)");
  });

  it("treats an empty string as missing", () => {
    const error = captureError(() => parseEnv(serverEnvSchema, { APP_ENV: "" }));
    expect(error.problems).toEqual([{ variable: "APP_ENV", reason: "missing" }]);
  });

  it("names an invalid variable without revealing its value", () => {
    const secretLooking = "sk_live_should-never-be-printed";
    const error = captureError(() => parseEnv(serverEnvSchema, { APP_ENV: secretLooking }));
    expect(error.problems).toEqual([{ variable: "APP_ENV", reason: "invalid" }]);
    expect(error.message).not.toContain(secretLooking);
    expect(JSON.stringify(error.problems)).not.toContain(secretLooking);
  });

  it("rejects non-http URLs for the public app URL without echoing them", () => {
    const value = "javascript:alert(1)";
    const error = captureError(() => parseEnv(publicEnvSchema, { NEXT_PUBLIC_APP_URL: value }));
    expect(error.problems).toEqual([{ variable: "NEXT_PUBLIC_APP_URL", reason: "invalid" }]);
    expect(error.message).not.toContain(value);
  });

  it("reports every failing variable once", () => {
    const schema = serverEnvSchema.extend(publicEnvSchema.shape);
    const error = captureError(() => parseEnv(schema, { NEXT_PUBLIC_APP_URL: "not a url" }));
    expect(error.problems).toEqual([
      { variable: "APP_ENV", reason: "missing" },
      { variable: "NEXT_PUBLIC_APP_URL", reason: "invalid" },
    ]);
  });

  it("ignores variables outside the schema", () => {
    const parsed = parseEnv(serverEnvSchema, { APP_ENV: "test", UNRELATED_SECRET: "x" });
    expect(parsed).toEqual({ APP_ENV: "test" });
  });
});
