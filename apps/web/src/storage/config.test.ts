import { EnvValidationError } from "@madeora/config/env";

import { parseWebStorageSettings } from "./config";

const SECRET_KEY = "sb_secret_synthetic0123456789abcdef";
const SECRET_ACCESS = "SyntheticSecretAccessKey0123456789abcd";
const s3 = {
  STORAGE_DRIVER: "s3",
  STORAGE_S3_ENDPOINT: "http://127.0.0.1:54390",
  STORAGE_S3_BUCKET: "madeora-test",
  STORAGE_S3_ACCESS_KEY_ID: "SyntheticAccessKey01",
  STORAGE_S3_SECRET_ACCESS_KEY: SECRET_ACCESS,
  SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY,
};

describe("parseWebStorageSettings", () => {
  it("is off (null) when the driver is unset or off, with no other settings needed", () => {
    expect(parseWebStorageSettings({})).toBeNull();
    expect(parseWebStorageSettings({ STORAGE_DRIVER: "off" })).toBeNull();
  });

  it("returns the store and the finalize key when storage is on", () => {
    const settings = parseWebStorageSettings(s3);
    expect(settings?.serviceRoleKey).toBe(SECRET_KEY);
    expect(settings?.store).toMatchObject({ bucket: "madeora-test" });
  });

  it("requires the Supabase secret key when storage is on, naming it without values", () => {
    const { SUPABASE_SERVICE_ROLE_KEY: _omitted, ...withoutKey } = s3;
    expect(() => parseWebStorageSettings(withoutKey)).toThrow(EnvValidationError);
    expect(() => parseWebStorageSettings(withoutKey)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("refuses a malformed key and plain http to another machine, never echoing secrets", () => {
    const attempt = (source: Record<string, string>) => {
      try {
        parseWebStorageSettings(source);
        return "accepted";
      } catch (error) {
        return error instanceof Error ? error.message : "unknown";
      }
    };
    const badKey = attempt({ ...s3, SUPABASE_SERVICE_ROLE_KEY: "publishable-oops" });
    expect(badKey).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(badKey).not.toContain("publishable-oops");
    const remoteHttp = attempt({ ...s3, STORAGE_S3_ENDPOINT: "http://storage.example.com" });
    expect(remoteHttp).toMatch(/STORAGE_S3_ENDPOINT/);
    expect(remoteHttp).not.toContain(SECRET_ACCESS);
  });
});
