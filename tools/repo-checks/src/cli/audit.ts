// Usage: node tools/repo-checks/src/cli/audit.ts   (run from the repository root)
// Runs `pnpm audit --json`, then fails on high or critical advisories that have no
// unexpired exception in tools/repo-checks/audit-exceptions.json.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditPassed,
  evaluateAudit,
  exceptionsFileSchema,
  parseAuditReport,
  type Advisory,
} from "../audit.ts";

const exceptionsPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../audit-exceptions.json",
);

function describe(advisory: Advisory): string {
  return `${advisory.severity} ${advisory.package} ${advisory.id}: ${advisory.title} (${advisory.url})`;
}

let result;
try {
  const exceptions = exceptionsFileSchema.parse(
    JSON.parse(readFileSync(exceptionsPath, "utf8")),
  ).exceptions;
  // pnpm audit exits non-zero whenever it finds advisories, so the exit code is not used;
  // the JSON report is parsed instead, and anything unparseable fails below.
  const audit = spawnSync("pnpm", ["audit", "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (audit.error) throw audit.error;
  const today = new Date().toISOString().slice(0, 10);
  result = evaluateAudit(parseAuditReport(audit.stdout), exceptions, today);
} catch (error) {
  // Fail closed: if the registry cannot be reached or the report is malformed, do not pass.
  console.error("Dependency audit could not run:", error instanceof Error ? error.message : error);
  process.exit(2);
}

for (const advisory of result.warnings) {
  console.log(`Warning (not blocking): ${describe(advisory)}`);
}
for (const advisory of result.excepted) {
  console.log(`Allowed by a recorded exception: ${describe(advisory)}`);
}
for (const exception of result.unused) {
  console.log(`Exception no longer needed, remove it: ${exception.id} (${exception.package})`);
}

if (!auditPassed(result)) {
  console.error("Dependency audit failed.");
  for (const advisory of result.blocking) console.error(`  - ${describe(advisory)}`);
  for (const problem of result.exceptionProblems) console.error(`  - ${problem}`);
  console.error("See docs/development.md, section 'Dependency audit exceptions'.");
  process.exit(1);
}
console.log("Dependency audit passed: no unexcepted high or critical advisories.");
