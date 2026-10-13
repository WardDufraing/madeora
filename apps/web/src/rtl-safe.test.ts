import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The layout must work in right-to-left languages (spec), so the web app uses logical directions
 * only: `ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`, `border-s`/`border-e`, `rounded-s`/`rounded-e`,
 * `text-start`/`text-end` in Tailwind and `margin-inline-start` and so on in CSS. Physical left
 * and right would not mirror. `rtl:` variants are allowed for the rare case that needs one, such
 * as mirroring an arrow icon. The browser test checks the mirrored shell itself.
 */

const VALUE = String.raw`-[\w./[\]()%#-]+`;
// One Tailwind utility (variants already removed) that uses a physical side.
const PHYSICAL_TAILWIND = new RegExp(
  String.raw`^-?(?:` +
    String.raw`(?:(?:scroll-)?[mp][lr]|left|right|inset-[lr])${VALUE}` +
    String.raw`|(?:border-[lr]|rounded-(?:[lr]|tl|tr|bl|br))(?:${VALUE})?` +
    String.raw`|(?:text|float|clear)-(?:left|right)` +
    String.raw`|origin-(?:top-|bottom-)?(?:left|right)` +
    String.raw`)$`,
);

const PHYSICAL_CSS =
  /\b(?:margin|padding|border)-(?:left|right)\b|(?<![\w-])(?:left|right)\s*:|text-align\s*:\s*(?:left|right)\b|float\s*:\s*(?:left|right)\b/;

/** Physical-direction classes in the string literals of one source line. */
export function findPhysicalDirections(text: string, extension: string): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, index) => {
    const at = `line ${String(index + 1)}: ${line.trim()}`;
    if (extension === ".css") {
      if (PHYSICAL_CSS.test(line)) hits.push(`physical CSS property, ${at}`);
      return;
    }
    for (const [, , literal = ""] of line.matchAll(/(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
      for (const token of literal.split(/\s+/)) {
        // Strip variants such as `md:` or `hover:`; an `rtl:`/`ltr:` variant is deliberate.
        const parts = token.split(":");
        if (parts.some((part) => part === "rtl" || part === "ltr")) continue;
        const utility = parts.at(-1) ?? "";
        if (PHYSICAL_TAILWIND.test(utility)) {
          hits.push(`physical class "${utility}", ${at}`);
        }
      }
    }
  });
  return hits;
}

const root = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = `${dir}/${entry}`;
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:tsx?|css)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe("right-to-left safety", () => {
  it("finds physical directions (the detector itself)", () => {
    for (const bad of [
      `className="ml-2"`,
      `className="md:pr-4"`,
      `"left-0 top-0"`,
      `"border-l border-line"`,
      `"rounded-tl-card"`,
      `"text-right"`,
      `"-mr-2"`,
      `"hover:right-[3px]"`,
    ]) {
      expect(findPhysicalDirections(bad, ".tsx"), bad).not.toEqual([]);
    }
    expect(findPhysicalDirections("  margin-left: 4px;", ".css")).not.toEqual([]);
    expect(findPhysicalDirections("  left: 0;", ".css")).not.toEqual([]);
  });

  it("allows logical directions, rtl variants and ordinary words", () => {
    for (const good of [
      `className="ms-2 pe-4 start-0 end-0 border-e rounded-s-card text-start"`,
      `"rtl:-scale-x-100"`,
      `"before:start-0 -me-2"`,
      `"The left sidebar"`,
      `"mx-auto px-4 py-2"`,
    ]) {
      expect(findPhysicalDirections(good, ".tsx"), good).toEqual([]);
    }
    expect(findPhysicalDirections("  margin-inline-start: 4px;", ".css")).toEqual([]);
  });

  it("the web app uses logical directions only", () => {
    const hits = sourceFiles(root).flatMap((file) =>
      findPhysicalDirections(readFileSync(file, "utf8"), extname(file)).map(
        (hit) => `${file.slice(root.length + 1)}: ${hit}`,
      ),
    );
    expect(hits).toEqual([]);
  });
});
