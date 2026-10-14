import { describe, expect, it } from "vitest";

import { applyVercelPreviewDefaults, vercelPreviewDefaults } from "./vercel.ts";

const preview = { VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "madeora-git-feat-x-ward.vercel.app" };

describe("vercelPreviewDefaults", () => {
  it("fills APP_ENV and the branch URL on a Vercel preview", () => {
    expect(vercelPreviewDefaults(preview)).toEqual({
      APP_ENV: "preview",
      NEXT_PUBLIC_APP_URL: "https://madeora-git-feat-x-ward.vercel.app",
    });
  });

  it("accepts an explicit preview target", () => {
    expect(vercelPreviewDefaults({ ...preview, VERCEL_TARGET_ENV: "preview" })).toMatchObject({
      NEXT_PUBLIC_APP_URL: "https://madeora-git-feat-x-ward.vercel.app",
    });
  });

  it("does not use the per-deployment URL", () => {
    expect(
      vercelPreviewDefaults({
        VERCEL_ENV: "preview",
        VERCEL_URL: "madeora-abc123-ward.vercel.app",
      }),
    ).toEqual({ APP_ENV: "preview" });
  });

  it("never replaces values that are already set", () => {
    expect(
      vercelPreviewDefaults({
        ...preview,
        APP_ENV: "test",
        NEXT_PUBLIC_APP_URL: "https://preview.example.test",
      }),
    ).toEqual({});
  });

  it("treats empty values as missing", () => {
    expect(vercelPreviewDefaults({ ...preview, APP_ENV: "", NEXT_PUBLIC_APP_URL: "" })).toEqual({
      APP_ENV: "preview",
      NEXT_PUBLIC_APP_URL: "https://madeora-git-feat-x-ward.vercel.app",
    });
  });

  it.each([
    ["production", { ...preview, VERCEL_ENV: "production" }],
    ["development", { ...preview, VERCEL_ENV: "development" }],
    ["outside Vercel", { VERCEL_BRANCH_URL: preview.VERCEL_BRANCH_URL }],
    ["a custom (staging) environment", { ...preview, VERCEL_TARGET_ENV: "staging" }],
  ])("adds nothing in %s, so missing values still fail validation", (_name, source) => {
    expect(vercelPreviewDefaults(source)).toEqual({});
  });

  it.each([
    "https://evil.example",
    "evil.example/path",
    "evil.example:8080",
    "user@evil.example",
    "localhost",
    "madeora.example.com",
    "evil.example/x.vercel.app",
    "vercel.app",
    "",
  ])("ignores a host that is not a bare host name: %j", (host) => {
    expect(vercelPreviewDefaults({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: host })).toEqual({
      APP_ENV: "preview",
    });
  });
});

describe("applyVercelPreviewDefaults", () => {
  it("writes the defaults into the given environment and returns them", () => {
    const env: Record<string, string | undefined> = { ...preview };
    const added = applyVercelPreviewDefaults(env);
    expect(added).toEqual({
      APP_ENV: "preview",
      NEXT_PUBLIC_APP_URL: "https://madeora-git-feat-x-ward.vercel.app",
    });
    expect(env).toMatchObject(added);
  });

  it("leaves a production environment untouched", () => {
    const env: Record<string, string | undefined> = { VERCEL_ENV: "production" };
    expect(applyVercelPreviewDefaults(env)).toEqual({});
    expect(env).toEqual({ VERCEL_ENV: "production" });
  });
});
