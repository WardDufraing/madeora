import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import * as icons from "./index.ts";

const iconComponents = Object.entries(icons).filter(([name]) => name.endsWith("Icon"));

describe("icons", () => {
  it("does not export createIcon, so no icon can skip the SVG reader", () => {
    expect(Object.keys(icons)).not.toContain("createIcon");
  });

  it("exports exactly the icons listed in the README inventory", () => {
    const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    const listed = [...readme.matchAll(/^\| `(\w+Icon)` +\|/gm)].map((match) => match[1]);
    expect(listed.length).toBeGreaterThan(0);
    expect(iconComponents.map(([name]) => name).sort()).toEqual(listed.sort());
  });

  for (const [name, Icon] of iconComponents) {
    it(`${name} is decorative by default and draws only with currentColor`, () => {
      const markup = renderToStaticMarkup(createElement(Icon));
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain('focusable="false"');
      expect(markup).not.toContain("role=");
      expect(markup).toContain('stroke="currentColor"');
      expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|href|on[a-z]+=|style=/i);
      expect(markup).toContain('width="20"');
    });
  }

  it("gets an accessible name and image role when given a title", () => {
    const markup = renderToStaticMarkup(
      createElement(icons.WarningIcon, { title: "Warning", size: "lg" }),
    );
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Warning"');
    expect(markup).not.toContain("aria-hidden");
    expect(markup).toContain('width="24"');
  });

  it("treats a blank title as decorative", () => {
    const markup = renderToStaticMarkup(createElement(icons.InfoIcon, { title: "  " }));
    expect(markup).toContain('aria-hidden="true"');
  });

  it("escapes the title", () => {
    const markup = renderToStaticMarkup(createElement(icons.InfoIcon, { title: '"><script>' }));
    expect(markup).not.toContain("<script>");
  });
});
