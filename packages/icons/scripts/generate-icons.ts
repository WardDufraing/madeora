// Generates src/generated/icons.ts from svg/*.svg through the strict reader in parse-svg.ts.
// With --check, only reports whether the committed file is up to date (exit 1 if not).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { componentName, parseIconSvg } from "./parse-svg.ts";

const svgDir = fileURLToPath(new URL("../svg/", import.meta.url));
const output = fileURLToPath(new URL("../src/generated/icons.ts", import.meta.url));

export function renderIconsModule(): string {
  const files = readdirSync(svgDir)
    .filter((file) => file.endsWith(".svg"))
    .sort();
  const lines = [
    "// Generated from packages/icons/svg by `pnpm --filter @madeora/icons generate`. Do not edit.",
    'import { createIcon } from "../create-icon.ts";',
    "",
  ];
  for (const file of files) {
    const name = componentName(file);
    const elements = parseIconSvg(readFileSync(`${svgDir}${file}`, "utf8"), file);
    lines.push(`export const ${name}Icon = createIcon("${name}", ${JSON.stringify(elements)});`);
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  const expected = renderIconsModule();
  let current: string | undefined;
  try {
    current = readFileSync(output, "utf8");
  } catch {
    current = undefined;
  }
  if (process.argv.includes("--check")) {
    if (current !== expected) {
      console.error(
        "Out of date: packages/icons/src/generated/icons.ts. Run `pnpm --filter @madeora/icons generate`.",
      );
      process.exitCode = 1;
    }
  } else if (current !== expected) {
    writeFileSync(output, expected);
    console.log(`Wrote ${output}`);
  }
}
