import { deriveAccent, themes, type AccentTokens, type Theme } from "@madeora/design-tokens";
import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";

// Real-browser checks for the S04 design tokens and base components, on the development-only
// component preview. Colour contrast can only be measured here, not in jsdom.

const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

interface AxeResult {
  violations: { id: string; help: string; nodes: { target: string[] }[] }[];
}

/** Waits for enter animations to finish, so contrast is measured at full opacity. */
async function settle(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    ),
  );
}

async function axeViolations(page: Page): Promise<string[]> {
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

async function open(page: Page, theme: Theme) {
  await page.goto("/dev/components");
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await expect(page.getByRole("heading", { level: 1, name: "Component preview" })).toBeVisible();
}

/** Every distinct colour the page paints, as computed by the browser. */
async function paintedColours(page: Page): Promise<Set<string>> {
  const colours = await page.evaluate(() => {
    const found: string[] = [];
    for (const element of document.querySelectorAll("*")) {
      const style = getComputedStyle(element);
      found.push(
        style.color,
        style.backgroundColor,
        style.borderTopColor,
        style.outlineColor,
        style.fill,
        style.stroke,
      );
      const backdrop = getComputedStyle(element, "::backdrop");
      found.push(backdrop.backgroundColor);
    }
    return found;
  });
  return new Set(colours);
}

function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${String((value >> 16) & 255)}, ${String((value >> 8) & 255)}, ${String(value & 255)})`;
}

const accentKeys: readonly (keyof AccentTokens)[] = [
  "accent",
  "accentHover",
  "accentPressed",
  "accentSubtle",
  "accentFg",
  "focusRing",
];

function cssName(key: keyof AccentTokens): string {
  return key === "focusRing"
    ? "--md-color-focus"
    : `--md-color-${key.replace(/[A-Z]/g, (l) => `-${l.toLowerCase()}`)}`;
}

for (const theme of themes) {
  test.describe(`${theme} theme`, () => {
    test("the preview has no axe violations, including colour contrast", async ({ page }) => {
      await open(page, theme);
      expect(await axeViolations(page)).toEqual([]);
    });

    test("an open dialog and every toast tone have no axe violations", async ({ page }) => {
      await open(page, theme);
      for (const tone of ["info", "success", "warning", "error"]) {
        await page.getByRole("button", { name: `Show ${tone} toast` }).click();
      }
      await page.getByRole("button", { name: "Show toast with action" }).click();
      await expect(page.getByRole("listitem").filter({ hasText: "Item deleted" })).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);

      await page.getByRole("button", { name: "Open dialog" }).click();
      await expect(page.getByRole("dialog", { name: "Example dialog" })).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
    });

    test("changing the accent tokens recolours every accent use", async ({ page }) => {
      await open(page, theme);
      const purple = deriveAccent(theme === "light" ? "#8057f5" : "#936bff", theme);
      const green = deriveAccent("#0e7c66", theme);

      // Control: the default accent is painted before the swap.
      await page.getByRole("checkbox", { name: "Checked", exact: true }).focus();
      expect(await paintedColours(page)).toContain(rgb(purple.accent));

      await page.evaluate(
        (vars) => {
          for (const [name, value] of vars) document.documentElement.style.setProperty(name, value);
        },
        [...accentKeys, "onAccent" as const].map((key): [string, string] => [
          cssName(key),
          green[key],
        ]),
      );

      const primary = page.getByRole("button", { name: "Primary" });
      await expect(primary).toHaveCSS("background-color", rgb(green.accent));
      await expect(page.getByRole("checkbox", { name: "Checked", exact: true })).toHaveCSS(
        "background-color",
        rgb(green.accent),
      );
      await expect(page.getByRole("link", { name: "View all" })).toHaveCSS(
        "color",
        rgb(green.accentFg),
      );
      await primary.hover();
      await expect(primary).toHaveCSS("background-color", rgb(green.accentHover));
      await page.keyboard.press("Tab");
      await expect(page.locator(":focus-visible")).toHaveCSS("outline-color", rgb(green.focusRing));

      // Nothing painted on the page still uses any default accent colour.
      const painted = await paintedColours(page);
      for (const key of accentKeys) expect(painted, key).not.toContain(rgb(purple[key]));
    });
  });
}

test("follows the operating system's dark mode when no theme is forced", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/dev/components");
  await expect(page.locator("body")).toHaveCSS("background-color", rgb("#10141d"));
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await expect(page.locator("body")).toHaveCSS("background-color", rgb("#f7f8fc"));
});

test("the atmospheric background is on the page only and disappears with forced colours", async ({
  page,
}) => {
  await page.goto("/dev/components");
  await expect(page.locator("body")).toHaveCSS("background-image", /radial-gradient/);
  const gradients = await page.evaluate(
    () =>
      [...document.querySelectorAll("body *")].filter(
        (el) => getComputedStyle(el).backgroundImage !== "none",
      ).length,
  );
  expect(gradients).toBe(0);

  await page.emulateMedia({ forcedColors: "active" });
  await expect(page.locator("body")).toHaveCSS("background-image", "none");
});

test("reduced motion sets every duration token to zero", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/dev/components");
  const durations = await page.evaluate(() =>
    ["fast", "base", "slow"].map((n) =>
      getComputedStyle(document.documentElement).getPropertyValue(`--md-duration-${n}`),
    ),
  );
  // The production CSS minifier may write 0ms as 0s.
  for (const value of durations) expect(value.trim()).toMatch(/^0m?s$/);
});

test("the dialog traps focus, closes on Escape and returns focus to its opener", async ({
  page,
}) => {
  await page.goto("/dev/components");
  const opener = page.getByRole("button", { name: "Open dialog" });
  await opener.focus();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Example dialog" });
  await expect(dialog).toBeVisible();
  // Tab stays inside the dialog. Past its last control the browser may move focus to its own
  // toolbar (document.body here), but never to the page behind the dialog.
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Tab");
    const where = await dialog.evaluate((el) =>
      el.contains(document.activeElement)
        ? "dialog"
        : document.activeElement === document.body
          ? "browser"
          : "page",
    );
    expect(where).not.toBe("page");
  }
  // The rest of the page is inert while the dialog is open.
  expect(
    await page.getByRole("button", { name: "Primary" }).evaluate((el) => el.matches(":modal *")),
  ).toBe(false);
  expect(await page.evaluate(() => document.querySelector("dialog")?.matches(":modal"))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("a toast can be dismissed from the keyboard", async ({ page }) => {
  await page.goto("/dev/components");
  await page.getByRole("button", { name: "Show toast with action" }).click();
  const toast = page.getByRole("listitem").filter({ hasText: "Item deleted" });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "Dismiss" }).focus();
  await page.keyboard.press("Enter");
  await expect(toast).toBeHidden();
});
