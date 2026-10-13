// The server/client boundary of the environment modules (architecture.md §20, S01 review L3).
// These tests run Node itself, without the Vitest stand-in for "server-only", so they see what a
// real bundler sees.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

function importAs(specifier: string, conditions: readonly string[]) {
  const script = `await import(${JSON.stringify(specifier)});`;
  return spawnSync(
    process.execPath,
    [...conditions.map((c) => `--conditions=${c}`), "--input-type=module", "--eval", script],
    { cwd: packageRoot, encoding: "utf8", env: { ...process.env, APP_ENV: "test" } },
  );
}

describe("env/server", () => {
  it("starts with the server-only marker, before any other import", () => {
    const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    const firstImport = source.split("\n").find((line) => line.startsWith("import "));
    expect(firstImport).toBe('import "server-only";');
  });

  it("cannot be loaded outside the React Server environment (what browser bundles resolve)", () => {
    const result = importAs("@madeora/config/env/server", []);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot be imported from a Client Component module");
  });

  it("loads in the React Server environment, where Next.js runs server code", () => {
    const result = importAs("@madeora/config/env/server", ["react-server"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

describe("env/public", () => {
  it("loads anywhere, because it holds no secrets", () => {
    const result = importAs("@madeora/config/env/public", []);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("does not import the server module", () => {
    const source = readFileSync(new URL("./public.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "\.\/server|server-only/);
  });
});
