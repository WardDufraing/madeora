import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { renderIconsModule } from "./generate-icons.ts";
import { componentName, parseIconSvg, ROOT_ATTRIBUTES } from "./parse-svg.ts";

const root = `<svg ${Object.entries(ROOT_ATTRIBUTES)
  .map(([name, value]) => `${name}="${value}"`)
  .join(" ")}>`;
const svg = (body: string, open = root) => `${open}\n  ${body}\n</svg>\n`;

describe("parseIconSvg", () => {
  it("reads the allowed shapes and their geometry", () => {
    expect(
      parseIconSvg(
        svg(
          '<path d="M6 6 18 18"/><circle cx="12" cy="12" r="9" /><line x1="1" y1="2" x2="3" y2="4"/>' +
            '<polyline points="5 12.5 10 17.5"/><rect x="3" y="3" width="18" height="18" rx="2"/>',
        ),
      ),
    ).toEqual([
      ["path", { d: "M6 6 18 18" }],
      ["circle", { cx: "12", cy: "12", r: "9" }],
      ["line", { x1: "1", y1: "2", x2: "3", y2: "4" }],
      ["polyline", { points: "5 12.5 10 17.5" }],
      ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }],
    ]);
  });

  const refused: [string, string][] = [
    ["a script element", svg("<script>alert(1)</script>")],
    ["a script inside a shape", svg('<path d="M0 0"><script>alert(1)</script></path>')],
    ["an event handler", svg('<path d="M0 0" onclick="alert(1)"/>')],
    [
      "an event handler on the root",
      svg('<path d="M0 0"/>', root.replace(">", ' onload="alert(1)">')),
    ],
    ["an href", svg('<path d="M0 0" href="https://example.com/x.svg"/>')],
    ["an xlink:href", svg('<path d="M0 0" xlink:href="#x"/>')],
    ["a use element", svg('<use href="#x"/>')],
    ["an image", svg('<image href="https://example.com/x.png"/>')],
    ["a foreignObject", svg('<foreignObject width="1" height="1"/>')],
    ["a style attribute", svg('<path d="M0 0" style="fill:red"/>')],
    ["a style element", svg("<style>path{fill:red}</style>")],
    ["a fill override", svg('<path d="M0 0" fill="#8057f5"/>')],
    ["a url() value", svg('<path d="url(#x)"/>')],
    ["a javascript: value", svg('<path d="javascript:alert(1)"/>')],
    ["an entity", svg('<path d="M0 0&amp;"/>')],
    ["a comment", svg('<!-- note --><path d="M0 0"/>')],
    ["text content", svg('hello<path d="M0 0"/>')],
    ["a group", svg('<g><path d="M0 0"/></g>')],
    ["a non-self-closing shape", svg('<path d="M0 0"></path>')],
    ["a duplicate attribute", svg('<path d="M0 0" d="M1 1"/>')],
    ["a single-quoted attribute", svg("<path d='M0 0'/>")],
    [
      "a different grid",
      svg('<path d="M0 0"/>', root.replace('viewBox="0 0 24 24"', 'viewBox="0 0 16 16"')),
    ],
    [
      "a different stroke",
      svg('<path d="M0 0"/>', root.replace('stroke-width="2"', 'stroke-width="1.5"')),
    ],
    ["a missing root attribute", svg('<path d="M0 0"/>', root.replace(' fill="none"', ""))],
    ["a DOCTYPE before the root", `<!DOCTYPE svg [<!ENTITY x "y">]>${svg('<path d="M0 0"/>')}`],
    ["content after the root", `${svg('<path d="M0 0"/>')}<script>alert(1)</script>`],
    ["no shapes", svg("")],
    ["an empty shape", svg("<path/>")],
  ];
  for (const [what, source] of refused) {
    it(`refuses ${what}`, () => {
      expect(() => parseIconSvg(source, "test.svg")).toThrow(/^test\.svg/);
    });
  }
});

describe("componentName", () => {
  it("turns hyphenated file names into component names", () => {
    expect(componentName("close.svg")).toBe("Close");
    expect(componentName("arrow-left.svg")).toBe("ArrowLeft");
  });

  it("refuses names that could break the generated module", () => {
    for (const bad of ['x"; alert(1); ".svg', "Close.svg", "two words.svg", "-x.svg"]) {
      expect(() => componentName(bad)).toThrow();
    }
  });
});

describe("generated icons", () => {
  it("are up to date (run `pnpm --filter @madeora/icons generate`)", () => {
    const committed = readFileSync(
      fileURLToPath(new URL("../src/generated/icons.ts", import.meta.url)),
      "utf8",
    );
    expect(committed).toBe(renderIconsModule());
  });
});
