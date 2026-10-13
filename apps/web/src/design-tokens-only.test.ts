import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Every colour in the interface must come from @madeora/design-tokens, so changing the accent
 * tokens recolours every accent use and nothing hard-codes the default purple
 * (docs/design/design-decisions.md, decision 1). Tailwind's colour palette is also removed, so
 * palette classes would not compile; this guard explains the failure in one place.
 */

const roots = ["../src", "../../../packages/icons/src", "../../../packages/icons/svg"].map((path) =>
  fileURLToPath(new URL(path, import.meta.url)),
);

const forbidden: [string, RegExp][] = [
  ["hex colour", /#[0-9a-f]{3,8}\b/i],
  ["CSS colour function", /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i],
  [
    "Tailwind palette colour",
    /\b(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/,
  ],
  ["named colour", /\b(?:purple|violet|indigo|fuchsia|magenta|lavender)\b/i],
  ["Tailwind black or white", /\b(?:bg|text|border|outline|ring|fill|stroke)-(?:black|white)\b/],
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return /\.(?:tsx?|css|svg)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("colours come only from design tokens", () => {
  const files = roots.flatMap(sourceFiles);

  it("scans the web app and icon sources", () => {
    expect(files.some((file) => file.endsWith("globals.css"))).toBe(true);
    expect(files.some((file) => file.endsWith("button.tsx"))).toBe(true);
    expect(files.some((file) => file.endsWith("close.svg"))).toBe(true);
  });

  for (const [what, pattern] of forbidden) {
    it(`has no ${what} outside packages/design-tokens`, () => {
      const hits = files.flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .flatMap((line, index) =>
            pattern.test(line) ? [`${file}:${String(index + 1)}: ${line.trim()}`] : [],
          ),
      );
      expect(hits).toEqual([]);
    });
  }
});
