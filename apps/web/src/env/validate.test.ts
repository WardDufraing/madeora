import { EnvValidationError } from "@madeora/config/env";

import { validateStartupEnv } from "./validate";

describe("validateStartupEnv", () => {
  it("accepts a complete configuration", () => {
    expect(
      validateStartupEnv({ APP_ENV: "test", NEXT_PUBLIC_APP_URL: "http://localhost:3000" }),
    ).toEqual({ APP_ENV: "test", NEXT_PUBLIC_APP_URL: "http://localhost:3000" });
  });

  it("fails with the names of missing variables", () => {
    expect(() => validateStartupEnv({})).toThrow(EnvValidationError);
    expect(() => validateStartupEnv({})).toThrow(
      /APP_ENV \(missing\).*NEXT_PUBLIC_APP_URL \(missing\)/,
    );
  });
});
