import { expect, test as base, type Page } from "@playwright/test";
import { createRequire } from "node:module";

const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

interface AxeResult {
  violations: { id: string; help: string; nodes: { target: string[] }[] }[];
}

/**
 * Playwright's `test`, failing any test whose page logs a console error or throws. A production
 * React build reports hydration mismatches this way (minified errors #418/#423 and their
 * recoverable-error logs), so this is also the hydration-warning check.
 */
/**
 * Whether the stack serves Supabase Realtime. CI's stack does; the local stand-in
 * (`pnpm test:e2e:fallback`) has none and sets `E2E_REALTIME=0`, so live-update assertions read
 * the page again instead and the browser's failed Realtime connection is not an error there.
 */
export const realtimeAvailable = process.env.E2E_REALTIME !== "0";
const realtimeUnavailable = /WebSocket connection to .*\/realtime\/v1\//;

export const test = base.extend<{
  /** Console messages a test expects, such as the browser's log line for a deliberate 404. */
  allowedConsoleErrors: readonly RegExp[];
  consoleGuard: undefined;
}>({
  allowedConsoleErrors: [[], { option: true }],
  consoleGuard: [
    async ({ page, allowedConsoleErrors }, use) => {
      const problems: string[] = [];
      page.on("console", (message) => {
        if (allowedConsoleErrors.some((pattern) => pattern.test(message.text()))) return;
        if (!realtimeAvailable && realtimeUnavailable.test(message.text())) return;
        if (message.type() === "error" || /hydrat/i.test(message.text())) {
          problems.push(`console ${message.type()}: ${message.text()}`);
        }
      });
      page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
      await use(undefined);
      expect(problems, "console errors, page errors or hydration warnings").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Waits for enter animations and transitions to finish, so colours are measured at rest. */
export async function settle(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        // A cancelled animation (for example when React re-renders its element) is at rest too;
        // its `finished` promise rejects with AbortError.
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

/** axe-core in the real browser, including colour contrast. */
export async function axeViolations(page: Page): Promise<string[]> {
  await settle(page);
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (context: Document) => Promise<AxeResult> } })
      .axe;
    return axe.run(document);
  });
  return result.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`,
  );
}

/**
 * Colours painted on visible elements that are not a `--md-color-*` token value. A member's own
 * identifying colour (an avatar, marked `data-member-colour`) is personal data, not design, and is
 * left out (its text, fill and the outline that defaults to its text colour); its border still
 * has to be a token.
 */
export async function nonTokenColours(page: Page): Promise<string[]> {
  await settle(page);
  return page.evaluate(() => {
    const probe = document.createElement("span");
    document.body.append(probe);
    const allowed = new Set(["rgba(0, 0, 0, 0)"]);
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (!(rule instanceof CSSStyleRule)) continue;
        for (const name of rule.style) {
          if (!name.startsWith("--md-color-")) continue;
          probe.style.color = `var(${name})`;
          allowed.add(getComputedStyle(probe).color);
        }
      }
    }
    probe.remove();

    const found = new Set<string>();
    for (const element of document.querySelectorAll("body, body *")) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const memberColour = element.closest("[data-member-colour]") !== null;
      for (const colour of memberColour
        ? [style.borderTopColor]
        : [style.color, style.backgroundColor, style.borderTopColor, style.outlineColor]) {
        found.add(colour);
      }
      if (element instanceof SVGElement && style.stroke !== "none") found.add(style.stroke);
      if (element instanceof HTMLDialogElement)
        found.add(getComputedStyle(element, "::backdrop").backgroundColor);
    }
    return [...found].filter((colour) => !allowed.has(colour));
  });
}
