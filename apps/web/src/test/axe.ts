import axe from "axe-core";

/**
 * Runs axe-core on rendered markup and returns readable violations (empty when there are none).
 *
 * jsdom cannot compute colours or layout, so colour contrast is checked in real Chromium by the
 * Playwright suite in both themes; here axe checks names, roles, ARIA and structure.
 * The "region" rule is for whole pages, not a single component.
 */
export async function axeViolations(container: Element): Promise<string[]> {
  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(" ")).join(", ")})`,
  );
}
