import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import * as icons from "./index.ts";

const iconComponents = Object.entries(icons).filter(([name]) => name !== "createIcon");

describe("icons", () => {
  it("exports every icon in the inventory", () => {
    expect(iconComponents.map(([name]) => name).sort()).toEqual([
      "CheckIcon",
      "CloseIcon",
      "ErrorIcon",
      "InfoIcon",
      "SpinnerIcon",
      "SuccessIcon",
      "WarningIcon",
    ]);
  });

  for (const [name, Icon] of iconComponents) {
    it(`${name} is decorative by default and draws only with currentColor`, () => {
      const markup = renderToStaticMarkup(createElement(Icon as icons.IconComponent));
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
