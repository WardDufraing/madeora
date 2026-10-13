import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SPEC_CHECKSUMS, runSpecGuard, specPathsIn } from "./spec-guard.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "cli/spec-guard.ts");
const specPaths = Object.keys(SPEC_CHECKSUMS);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitAll(cwd: string, message: string): string {
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "--no-verify", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

// A throwaway repository holding the real specification files and .gitattributes.
function createFixture(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "spec-guard-"));
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "Spec guard test");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.safecrlf", "false");
  mkdirSync(join(dir, "docs/product"), { recursive: true });
  for (const path of specPaths) copyFileSync(join(repoRoot, path), join(dir, path));
  copyFileSync(join(repoRoot, ".gitattributes"), join(dir, ".gitattributes"));
  writeFileSync(join(dir, "README.md"), "fixture\n");
  return { dir, base: commitAll(dir, "seed") };
}

const firstSpec = specPaths[0] ?? "";

describe("specPathsIn", () => {
  it("matches paths inside docs/product/ only", () => {
    expect(
      specPathsIn([
        "docs/product/Modules.md",
        "docs/product/new/nested.md",
        "docs/products.md",
        "docs/productivity/a.md",
        "README.md",
      ]),
    ).toEqual(["docs/product/Modules.md", "docs/product/new/nested.md"]);
  });
});

describe("runSpecGuard", () => {
  let dir = "";
  let base = "";

  beforeEach(() => {
    ({ dir, base } = createFixture());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes for the unchanged specification", () => {
    expect(runSpecGuard({ cwd: dir })).toEqual([]);
    expect(runSpecGuard({ cwd: dir, base })).toEqual([]);
  });

  it("passes when only files outside docs/product/ change", () => {
    appendFileSync(join(dir, "README.md"), "more\n");
    commitAll(dir, "unrelated change");
    expect(runSpecGuard({ cwd: dir, base })).toEqual([]);
  });

  it("fails when a spec file's content changes, even by one byte", () => {
    appendFileSync(join(dir, firstSpec), "\n");
    commitAll(dir, "edit spec");
    const problems = runSpecGuard({ cwd: dir, base });
    expect(problems).toContain(`${firstSpec}: content changed (sha256 differs)`);
    expect(problems.some((p) => p.includes("changed in this pull request"))).toBe(true);
  });

  it("fails on line-ending conversion of a spec file", () => {
    const original = execFileSync("git", ["show", `HEAD:${firstSpec}`], { cwd: dir });
    writeFileSync(join(dir, firstSpec), original.toString("utf8").replaceAll("\n", "\r\n"));
    expect(runSpecGuard({ cwd: dir })).toContain(`${firstSpec}: content changed (sha256 differs)`);
  });

  it("fails when a spec file is deleted", () => {
    git(dir, "rm", "--quiet", firstSpec);
    commitAll(dir, "delete spec");
    const problems = runSpecGuard({ cwd: dir, base });
    expect(problems).toContain(`${firstSpec}: missing`);
    expect(problems).toContain(
      `${firstSpec}: changed in this pull request (the product specification is read-only)`,
    );
  });

  it("fails on both paths when a spec file is renamed", () => {
    git(dir, "mv", firstSpec, "docs/renamed.md");
    commitAll(dir, "rename spec");
    const problems = runSpecGuard({ cwd: dir, base });
    expect(problems).toContain(`${firstSpec}: missing`);
    expect(problems).toContain(
      `${firstSpec}: changed in this pull request (the product specification is read-only)`,
    );
  });

  it("fails when a file is added to docs/product/", () => {
    writeFileSync(join(dir, "docs/product/extra.md"), "extra\n");
    commitAll(dir, "add file");
    const problems = runSpecGuard({ cwd: dir, base });
    expect(problems).toContain("docs/product/extra.md: unexpected file in docs/product/");
    expect(problems).toContain(
      "docs/product/extra.md: changed in this pull request (the product specification is read-only)",
    );
  });

  it("fails when .gitattributes adds a filter for the specification", () => {
    appendFileSync(join(dir, ".gitattributes"), "docs/product/** filter=rewrite\n");
    commitAll(dir, "add filter");
    expect(runSpecGuard({ cwd: dir })).toContain(
      `${firstSpec}: unexpected Git attributes (filter: rewrite)`,
    );
  });

  it("fails when .gitattributes no longer marks the specification -text", () => {
    writeFileSync(join(dir, ".gitattributes"), "*.png binary\n");
    commitAll(dir, "drop -text");
    expect(runSpecGuard({ cwd: dir })).toContain(
      `${firstSpec}: must have the "-text" Git attribute (see .gitattributes)`,
    );
  });

  it("fails when a nested .gitattributes inside docs/product/ changes attributes", () => {
    writeFileSync(join(dir, "docs/product/.gitattributes"), "* text eol=crlf\n");
    commitAll(dir, "nested attributes");
    const problems = runSpecGuard({ cwd: dir, base });
    expect(problems).toContain("docs/product/.gitattributes: unexpected file in docs/product/");
    expect(problems.some((p) => p.includes("unexpected Git attributes"))).toBe(true);
  });

  describe("command line", () => {
    function run(...args: string[]) {
      return spawnSync(process.execPath, [cliPath, ...args], { cwd: dir, encoding: "utf8" });
    }

    it("exits 0 when the specification is intact", () => {
      const result = run("--base", base);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Spec guard passed");
    });

    it("exits 1 and names the file when a pull request edits the specification", () => {
      appendFileSync(join(dir, firstSpec), "edit\n");
      commitAll(dir, "edit spec");
      const result = run("--base", base);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(firstSpec);
    });

    it("fails closed (exit 2) when the base commit does not exist", () => {
      const result = run("--base", "0000000000000000000000000000000000000001");
      expect(result.status).toBe(2);
    });
  });
});
