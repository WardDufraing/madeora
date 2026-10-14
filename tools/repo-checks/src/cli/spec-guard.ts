// Usage: node tools/repo-checks/src/cli/spec-guard.ts [--base <commit>] [--head <commit>]
// Without --base it checks checksums and Git attributes only (push events);
// with --base it also fails on any spec path changed since that commit (pull requests).
import { parseArgs } from "node:util";

import { runSpecGuard } from "../spec-guard.ts";

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    head: { type: "string" },
  },
});

let problems: string[];
try {
  problems = runSpecGuard({
    cwd: process.cwd(),
    ...(values.base === undefined ? {} : { base: values.base }),
    ...(values.head === undefined ? {} : { head: values.head }),
  });
} catch (error) {
  // Fail closed: a guard that cannot run must not pass.
  console.error("Spec guard could not run:", error instanceof Error ? error.message : error);
  process.exit(2);
}

if (problems.length > 0) {
  console.error("Spec guard failed. The product specification in docs/product/ is read-only.");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("Spec guard passed: docs/product/ is unchanged and byte-for-byte intact.");
