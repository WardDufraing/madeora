import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// apps/web/vercel.json decides which Vercel builds run (ADR 0005, ADR 0008). Vercel runs its
// `ignoreCommand` before each build: exit 0 skips the build, exit 1 builds.
const vercelJson: unknown = JSON.parse(
  readFileSync(new URL("../../../apps/web/vercel.json", import.meta.url), "utf8"),
);

function ignoreCommand(): string {
  if (
    typeof vercelJson === "object" &&
    vercelJson !== null &&
    "ignoreCommand" in vercelJson &&
    typeof vercelJson.ignoreCommand === "string"
  ) {
    return vercelJson.ignoreCommand;
  }
  throw new Error("apps/web/vercel.json has no ignoreCommand");
}

function builds(env: Record<string, string>): boolean {
  const result = spawnSync("sh", ["-c", ignoreCommand()], {
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  return result.status === 1;
}

describe("apps/web/vercel.json", () => {
  it("builds production only from the production branch", () => {
    expect(builds({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "production" })).toBe(true);
    expect(builds({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" })).toBe(false);
    expect(builds({ VERCEL_ENV: "production" })).toBe(false);
  });

  it("builds every preview", () => {
    expect(builds({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "main" })).toBe(true);
    expect(builds({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feat/x" })).toBe(true);
  });

  it("does not switch off Git deployments of any branch", () => {
    expect(vercelJson).not.toHaveProperty("git.deploymentEnabled");
  });
});
