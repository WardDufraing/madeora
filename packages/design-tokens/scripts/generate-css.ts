// Writes tokens.css and tailwind.css from the TypeScript tokens. With --check, only reports
// whether the committed files are up to date (exit 1 if not), as CI's tests do.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderTailwindCss, renderTokensCss } from "../src/css.ts";

const files = [
  { path: fileURLToPath(new URL("../tokens.css", import.meta.url)), render: renderTokensCss },
  { path: fileURLToPath(new URL("../tailwind.css", import.meta.url)), render: renderTailwindCss },
];

const check = process.argv.includes("--check");
let stale = false;
for (const file of files) {
  const expected = file.render();
  let current: string | undefined;
  try {
    current = readFileSync(file.path, "utf8");
  } catch {
    current = undefined;
  }
  if (current === expected) continue;
  if (check) {
    console.error(
      `Out of date: ${file.path}. Run \`pnpm --filter @madeora/design-tokens generate\`.`,
    );
    stale = true;
  } else {
    writeFileSync(file.path, expected);
    console.log(`Wrote ${file.path}`);
  }
}
process.exitCode = stale ? 1 : 0;
