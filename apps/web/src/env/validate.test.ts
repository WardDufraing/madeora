import { EnvValidationError } from "@madeora/config/env";

import { validateStartupEnv } from "./validate";

describe("validateStartupEnv", () => {
  it("accepts a complete configuration", () => {
    const env = {
      APP_ENV: "test",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic",
    };
    expect(validateStartupEnv(env)).toEqual(env);
  });

  it("fails with the names of missing variables", () => {
    expect(() => validateStartupEnv({})).toThrow(EnvValidationError);
    expect(() => validateStartupEnv({})).toThrow(
      /APP_ENV \(missing\).*NEXT_PUBLIC_APP_URL \(missing\).*NEXT_PUBLIC_SUPABASE_URL \(missing\).*NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \(missing\)/,
    );
  });
});
