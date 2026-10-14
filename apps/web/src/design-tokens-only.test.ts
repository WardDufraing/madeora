import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Every colour in the interface must come from @madeora/design-tokens, so changing the accent
 * tokens recolours every accent use and nothing hard-codes the default purple
 * (docs/design/design-decisions.md, decision 1). Tailwind's colour palette is removed, but
 * Tailwind still accepts arbitrary values such as `bg-[red]`, so this guard checks the sources.
 * Allowed: token utilities, `var(--md-…)`, `currentColor`, `transparent`, and CSS system colours
 * (Canvas, Highlight, …), which forced-colours (High Contrast) styles need.
 */

const roots = [
  "../src",
  "../test-fixtures",
  "../../../packages/icons/src",
  "../../../packages/icons/svg",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

// CSS Color 4 named colours (system colours and currentColor/transparent are not in this list).
const NAMED_COLOURS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown " +
    "burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan " +
    "darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
    "darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
    "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro " +
    "ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow " +
    "lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine " +
    "mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise " +
    "mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab " +
    "orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru " +
    "pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
    "seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan " +
    "teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
  ).split(" "),
);

const words = (text: string) => text.toLowerCase().split(/[^a-z]+/);
const hasNamedColour = (text: string) => words(text).some((word) => NAMED_COLOURS.has(word));

/** Returns a description of every hard-coded colour in one file's text. */
export function findHardCodedColours(text: string, extension: string): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, index) => {
    const at = `line ${String(index + 1)}: ${line.trim()}`;
    if (/#[0-9a-f]{3,8}\b/i.test(line)) hits.push(`hex colour, ${at}`);
    if (/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i.test(line)) {
      hits.push(`colour function, ${at}`);
    }
    if (
      /\b(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/.test(
        line,
      )
    ) {
      hits.push(`Tailwind palette colour, ${at}`);
    }
    if (
      /\b(?:bg|text|border|outline|ring|fill|stroke|decoration|caret|accent|shadow)-(?:black|white)\b/.test(
        line,
      )
    ) {
      hits.push(`Tailwind black or white, ${at}`);
    }
    // Tailwind arbitrary values: `bg-[rebeccapurple]`, `border-[color:red]`.
    for (const [, value = ""] of line.matchAll(/\[([^\]]*)\]/g)) {
      if (hasNamedColour(value)) hits.push(`named colour in an arbitrary value, ${at}`);
    }
    // CSS declarations: `color: red;`.
    if (extension === ".css") {
      const declaration = /^\s*[a-z-]+\s*:\s*([^;]+)/i.exec(line);
      if (declaration && hasNamedColour(declaration[1] ?? ""))
        hits.push(`named colour in CSS, ${at}`);
    }
    // String literals that are a colour on their own: `style={{ color: "red" }}`, `fill="red"`.
    for (const [, value = ""] of line.matchAll(/["'`]\s*([a-z]+)\s*["'`]/gi)) {
      if (NAMED_COLOURS.has(value.toLowerCase())) hits.push(`named colour string, ${at}`);
    }
  });
  return hits;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (statSync(path).isDirectory())
      return ["test", ".next", "node_modules"].includes(name) ? [] : sourceFiles(path);
    return /\.(?:tsx?|jsx?|mjs|mdx|css|svg)$/.test(name) && !/\.(?:test|spec)\.tsx?$/.test(name)
      ? [path]
      : [];
  });
}

describe("the hard-coded colour detector", () => {
  it.each([
    ['className="bg-[rebeccapurple]"', ".tsx"],
    ['className="border-[color:blueviolet]"', ".tsx"],
    ['className="bg-[#8057f5]"', ".tsx"],
    ['className="text-purple-500"', ".tsx"],
    ['className="text-white"', ".tsx"],
    ['style={{ color: "red" }}', ".tsx"],
    ['<path fill="mediumpurple" />', ".jsx"],
    ["  color: rebeccapurple;", ".css"],
    ["  background: color-mix(in srgb, white 10%, transparent);", ".css"],
    ['const c = "oklch(0.6 0.2 300)";', ".ts"],
  ])("catches %s", (line, extension) => {
    expect(findHardCodedColours(line, extension)).not.toEqual([]);
  });

  it.each([
    ['className="bg-accent text-on-accent border-line-control"', ".tsx"],
    ['className="forced-colors:checked:bg-[Highlight] forced-colors:text-[HighlightText]"', ".tsx"],
    ['className="w-[calc(100%-2rem)] duration-(--md-duration-fast)"', ".tsx"],
    ['stroke="currentColor"', ".tsx"],
    ["  background-color: var(--color-page);", ".css"],
    ["// The red error state and a gold star are fine in comments.", ".ts"],
  ])("allows %s", (line, extension) => {
    expect(findHardCodedColours(line, extension)).toEqual([]);
  });
});

describe("colours come only from design tokens", () => {
  const files = roots.flatMap(sourceFiles);

  it("scans the web app, the build fixtures and the icon sources", () => {
    for (const expected of [
      "globals.css",
      "button.tsx",
      "close.svg",
      "leaky-client-component.jsx",
    ]) {
      expect(
        files.some((file) => file.endsWith(expected)),
        expected,
      ).toBe(true);
    }
  });

  it("has no hard-coded colour outside packages/design-tokens", () => {
    const hits = files.flatMap((file) =>
      findHardCodedColours(readFileSync(file, "utf8"), file.slice(file.lastIndexOf("."))).map(
        (hit) => `${file}: ${hit}`,
      ),
    );
    expect(hits).toEqual([]);
  });
});
