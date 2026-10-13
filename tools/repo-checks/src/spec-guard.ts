// Guards the read-only product specification in docs/product/.
// Uses Node built-ins only, so CI can run it without installing dependencies.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SPEC_DIR = "docs/product/";

// sha256 of each specification file, byte for byte, as seeded in S00 (commit 33e0576).
// The specification is maintained outside this repository and never changes here,
// so these values never change either.
export const SPEC_CHECKSUMS: Readonly<Record<string, string>> = {
  "docs/product/Modules.md": "62bfcdd50394f1a1e54141699aeffa0583133f81a993792039b6f0059971d217",
  "docs/product/Project-entry.md":
    "d1d106a7c5df9f831ad2807432f5eebb64c5ac7eeb5a5da566be523abf11ce8c",
  "docs/product/Project-specification.md":
    "2d4a8778d25a2da6644045d57dff692efb7d01e89bf18f8f05cbd04561385d27",
};

// The only Git attribute the specification files may carry. "-text" stops line-ending
// conversion; anything else (filter, eol, ident, working-tree-encoding, ...) could change
// what is checked out without touching the files themselves.
const ALLOWED_ATTRIBUTES = new Set(["text: unset"]);

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function nulSeparated(output: string): string[] {
  return output.split("\0").filter((entry) => entry.length > 0);
}

/** Changed paths that fall inside the specification directory. */
export function specPathsIn(changedPaths: readonly string[]): string[] {
  return changedPaths.filter((path) => path.startsWith(SPEC_DIR));
}

/** Problems with the tracked specification files and their contents. */
export function checkSpecFiles(cwd: string): string[] {
  const problems: string[] = [];
  const expected = Object.keys(SPEC_CHECKSUMS).sort();
  // Each entry: "<mode> <object> <stage>\t<path>".
  const entries = nulSeparated(git(cwd, ["ls-files", "-s", "-z", "--", SPEC_DIR]));
  const modes = new Map<string, string>();
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    modes.set(entry.slice(tab + 1), entry.slice(0, entry.indexOf(" ")));
  }
  const tracked = [...modes.keys()].sort();

  for (const path of tracked) {
    if (!expected.includes(path)) problems.push(`${path}: unexpected file in ${SPEC_DIR}`);
  }
  for (const path of expected) {
    if (!tracked.includes(path)) {
      problems.push(`${path}: missing`);
      continue;
    }
    // 100644 is a regular, non-executable file. This rejects symlinks (120000) and
    // executable files (100755), which would otherwise pass a content check.
    if (modes.get(path) !== "100644") {
      problems.push(
        `${path}: must be a regular file with mode 100644 (found ${modes.get(path) ?? "none"})`,
      );
    }
    const actual = createHash("sha256")
      .update(readFileSync(join(cwd, path)))
      .digest("hex");
    if (actual !== SPEC_CHECKSUMS[path]) problems.push(`${path}: content changed (sha256 differs)`);
  }
  return problems;
}

/** Problems with the Git attributes that apply to the specification files. */
export function checkSpecAttributes(cwd: string): string[] {
  const problems: string[] = [];
  const paths = Object.keys(SPEC_CHECKSUMS);
  // Output with -z: path NUL attribute NUL value NUL, repeated.
  const fields = git(cwd, ["check-attr", "-z", "-a", "--", ...paths]).split("\0");
  const seen = new Map<string, string[]>(paths.map((path) => [path, []]));
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const path = fields[index] ?? "";
    seen.get(path)?.push(`${fields[index + 1] ?? ""}: ${fields[index + 2] ?? ""}`);
  }
  for (const [path, attributes] of seen) {
    const unexpected = attributes.filter((attribute) => !ALLOWED_ATTRIBUTES.has(attribute));
    if (unexpected.length > 0) {
      problems.push(`${path}: unexpected Git attributes (${unexpected.join(", ")})`);
    }
    if (!attributes.includes("text: unset")) {
      problems.push(`${path}: must have the "-text" Git attribute (see .gitattributes)`);
    }
  }
  return problems;
}

/** Problems with a change from `base` to `head`: any added, changed, renamed or deleted spec path. */
export function checkChangedPaths(cwd: string, base: string, head: string): string[] {
  // --no-renames reports a rename as a deletion plus an addition, so both paths are checked.
  const changed = nulSeparated(git(cwd, ["diff", "--name-only", "--no-renames", "-z", base, head]));
  return specPathsIn(changed).map(
    (path) => `${path}: changed in this pull request (the product specification is read-only)`,
  );
}

export interface SpecGuardOptions {
  cwd: string;
  /** When set, also fail if any spec path differs between this commit and `head`. */
  base?: string;
  head?: string;
}

export function runSpecGuard(options: SpecGuardOptions): string[] {
  const problems = [...checkSpecFiles(options.cwd), ...checkSpecAttributes(options.cwd)];
  if (options.base !== undefined) {
    problems.push(...checkChangedPaths(options.cwd, options.base, options.head ?? "HEAD"));
  }
  return problems;
}
