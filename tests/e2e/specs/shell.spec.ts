import type { BrowserContext, Page } from "@playwright/test";

import { axeViolations, expect, nonTokenColours, settle, test } from "../support/browser";

// S05: the app shell, theme and language. Every test also fails on console errors, page errors
// or hydration warnings (see support/browser.ts).

const desktop = { width: 1280, height: 800 };
const phone = { width: 390, height: 844 };

const navNames = {
  en: [
    "Dashboard",
    "Calendar",
    "Tasks",
    "Chores",
    "Meals",
    "Shopping",
    "Habits",
    "Pets",
    "Photos",
    "Integrations",
    "Settings",
    "Help",
  ],
  nl: [
    "Dashboard",
    "Agenda",
    "Taken",
    "Klusjes",
    "Maaltijden",
    "Boodschappen",
    "Gewoontes",
    "Huisdieren",
    "Foto's",
    "Koppelingen",
    "Instellingen",
    "Help",
  ],
} as const;

async function setCookies(context: BrowserContext, cookies: Record<string, string>, page: Page) {
  const url = new URL(page.url() === "about:blank" ? "http://127.0.0.1" : page.url());
  await context.addCookies(
    Object.entries(cookies).map(([name, value]) => ({
      name,
      value,
      domain: url.hostname,
      path: "/",
    })),
  );
}

const sidebar = (page: Page) => page.locator("aside");
const mainNav = (page: Page) => sidebar(page).getByRole("navigation");

/** Whether the page was fully reloaded since `markPage` (a marker set on window survives SPA updates). */
async function markPage(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __md_marker?: boolean }).__md_marker = true;
  });
}
async function stillSamePage(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __md_marker?: boolean }).__md_marker === true);
}

test.describe("desktop sidebar", () => {
  test.use({ viewport: desktop });

  test("collapses and expands, survives a reload, and gives the width to the main content", async ({
    page,
  }) => {
    await page.goto("/");
    const main = page.getByRole("main");
    const expandedMain = (await main.boundingBox())?.width ?? 0;
    expect(Math.round((await sidebar(page).boundingBox())?.width ?? 0)).toBe(240);

    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-state", "collapsed");
    await expect
      .poll(async () => Math.round((await sidebar(page).boundingBox())?.width ?? 0))
      .toBe(72);
    const collapsedMain = (await main.boundingBox())?.width ?? 0;
    expect(collapsedMain - expandedMain).toBeCloseTo(240 - 72, 0);

    await page.reload();
    await expect(sidebar(page)).toHaveAttribute("data-state", "collapsed");
    expect(Math.round((await sidebar(page).boundingBox())?.width ?? 0)).toBe(72);
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await page.reload();
    await expect(sidebar(page)).toHaveAttribute("data-state", "expanded");
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  });

  test("the server renders the saved sidebar state, so nothing jumps on load", async ({
    page,
    context,
  }) => {
    await setCookies(context, { "md-sidebar": "collapsed" }, page);
    const html = await (await page.request.get("/")).text();
    expect(html).toContain('data-state="collapsed"');
  });

  for (const state of ["expanded", "collapsed"] as const) {
    test(`keyboard reaches the skip link and every navigation item (${state})`, async ({
      page,
      context,
    }) => {
      await setCookies(context, { "md-sidebar": state }, page);
      await page.goto("/");

      // Names as assistive technology computes them.
      const focused = page.locator(":focus");
      await page.keyboard.press("Tab");
      await expect(focused).toHaveAccessibleName("Skip to main content");
      await page.keyboard.press("Tab");
      await expect(focused).toHaveAccessibleName("Madeora, go to the dashboard");
      await page.keyboard.press("Tab");
      await expect(focused).toHaveAccessibleName(
        state === "expanded" ? "Collapse sidebar" : "Expand sidebar",
      );
      for (const name of navNames.en) {
        await page.keyboard.press("Tab");
        await expect(focused).toHaveAccessibleName(name);
        await expect(focused).toHaveCSS("outline-style", "solid");
      }
    });
  }

  test("the skip link moves focus to the main content", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
  });

  test("collapsed items show their name as a tooltip on focus and hover; Escape hides it", async ({
    page,
    context,
  }) => {
    await setCookies(context, { "md-sidebar": "collapsed" }, page);
    await page.goto("/");
    const link = mainNav(page).getByRole("link", { name: "Calendar" });
    const tooltip = link.locator("[aria-hidden] > span");
    await expect(tooltip).toBeHidden();

    await link.focus();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText("Calendar");
    await settle(page);
    const linkBox = await link.boundingBox();
    const tipBox = await tooltip.boundingBox();
    expect(tipBox?.x ?? 0).toBeGreaterThanOrEqual((linkBox?.x ?? 0) + (linkBox?.width ?? 0));

    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
    await expect(link).toBeFocused();

    // Hover shows it again, and the pointer can move onto the tooltip without losing it.
    await page.keyboard.press("Tab");
    await link.hover();
    await expect(tooltip).toBeVisible();
    await tooltip.hover();
    await expect(tooltip).toBeVisible();
  });

  test("marks the current page with aria-current and a non-colour cue", async ({ page }) => {
    await page.goto("/calendar");
    const current = mainNav(page).getByRole("link", { name: "Calendar" });
    await expect(current).toHaveAttribute("aria-current", "page");
    await expect(current).toHaveCSS("font-weight", "600");
    await expect(page.locator('aside [aria-current="page"]')).toHaveCount(1);
  });

  for (const state of ["expanded", "collapsed"] as const) {
    test(`the first item's focus ring is not clipped by the scrolling navigation (${state})`, async ({
      page,
      context,
    }) => {
      await setCookies(context, { "md-sidebar": state }, page);
      await page.goto("/");
      const first = mainNav(page).getByRole("link").first();
      await first.focus();
      const [ring, nav] = await Promise.all([
        first.evaluate((el) => {
          const style = getComputedStyle(el);
          const extra =
            Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
          const box = el.getBoundingClientRect();
          return { top: box.top - extra, bottom: box.bottom + extra };
        }),
        mainNav(page).evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect),
      ]);
      expect(ring.top).toBeGreaterThanOrEqual(nav.top);
    });
  }

  test("in forced colours, the current page keeps its start-edge bar in a system colour", async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await page.goto("/calendar");
    const current = mainNav(page).getByRole("link", { name: "Calendar" });
    const [bar, canvas] = await current.evaluate((el) => [
      getComputedStyle(el, "::before").backgroundColor,
      getComputedStyle(document.body).backgroundColor,
    ]);
    expect(bar).not.toBe("rgba(0, 0, 0, 0)");
    expect(bar).not.toBe(canvas);
  });

  test("the sidebar width animation stops under reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(sidebar(page)).toHaveCSS("transition-duration", "0s");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(sidebar(page)).toHaveCSS("transition-duration", "0.24s");
  });
});

test.describe("theme", () => {
  test.use({ viewport: desktop });

  test("switches light, dark and system at once and after a reload", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/settings");
    const html = page.locator("html");
    const pageColour = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const light = await pageColour();
    await expect(page.getByRole("radio", { name: "Same as this device" })).toBeChecked();
    await expect(html).not.toHaveAttribute("data-theme");

    await markPage(page);
    await page.getByRole("radio", { name: "Dark" }).check();
    await expect(html).toHaveAttribute("data-theme", "dark");
    const dark = await pageColour();
    expect(dark).not.toBe(light);
    expect(await stillSamePage(page)).toBe(true);

    await page.reload();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(await pageColour()).toBe(dark);

    await page.getByRole("radio", { name: "Light" }).check();
    await expect(html).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await pageColour()).toBe(light);

    // "Same as this device" follows the operating system, now dark.
    await page.getByRole("radio", { name: "Same as this device" }).check();
    await expect(html).not.toHaveAttribute("data-theme");
    expect(await pageColour()).toBe(dark);
    await page.reload();
    await expect(html).not.toHaveAttribute("data-theme");
    expect(await pageColour()).toBe(dark);
  });

  test("after changing the theme, Back shows the new choice and every option still works", async ({
    page,
  }) => {
    await page.goto("/settings");
    await page.getByRole("radio", { name: "Dark" }).check();
    await mainNav(page).getByRole("link", { name: "Calendar" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
    await page.getByRole("radio", { name: "Same as this device" }).check();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme");
  });

  test("the server renders the saved theme on <html>, so the first paint is right", async ({
    page,
    context,
  }) => {
    await setCookies(context, { "md-theme": "dark" }, page);
    const html = await (await page.request.get("/")).text();
    expect(html).toMatch(/<html[^>]*data-theme="dark"/);
  });

  test("an invalid saved theme falls back to the device setting", async ({ page, context }) => {
    await setCookies(context, { "md-theme": "purple" }, page);
    await page.goto("/");
    await expect(page.locator("html")).not.toHaveAttribute("data-theme");
  });
});

test.describe("language", () => {
  test.use({ viewport: desktop });

  test("a first visit follows the browser's language", async ({ browser }) => {
    const context = await browser.newContext({ locale: "nl-BE", viewport: desktop });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "nl");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await expect(page.getByRole("navigation", { name: "Hoofdmenu" })).toBeVisible();
    await expect(page).toHaveTitle("Dashboard · Madeora");
    await context.close();
  });

  test("switches between Dutch and English at once and after a reload", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");

    await markPage(page);
    await page.getByRole("radio", { name: "Nederlands" }).check();
    await expect(page.locator("html")).toHaveAttribute("lang", "nl");
    await expect(page.getByRole("heading", { level: 1, name: "Instellingen" })).toBeVisible();
    await expect(mainNav(page).getByRole("link")).toHaveText([...navNames.nl]);
    await expect(page).toHaveTitle("Instellingen · Madeora");
    expect(await stillSamePage(page)).toBe(true);

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "nl");
    await expect(page.getByRole("radio", { name: "Nederlands" })).toBeChecked();

    await page.getByRole("radio", { name: "English" }).check();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(mainNav(page).getByRole("link")).toHaveText([...navNames.en]);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  });

  test("two people on different devices each get their own language", async ({ browser }) => {
    const dutch = await browser.newContext({ locale: "nl-NL" });
    const english = await browser.newContext({ locale: "en-GB" });
    const [nlPage, enPage] = await Promise.all([dutch.newPage(), english.newPage()]);
    await Promise.all([nlPage.goto("/settings"), enPage.goto("/settings")]);
    await expect(nlPage.getByRole("heading", { level: 1 })).toHaveText("Instellingen");
    await expect(enPage.getByRole("heading", { level: 1 })).toHaveText("Settings");
    await Promise.all([dutch.close(), english.close()]);
  });

  test("an invalid saved language is ignored", async ({ page, context }) => {
    await setCookies(context, { "md-locale": "xx" }, page);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });
});

test.describe("server and client agree", () => {
  test.use({ viewport: desktop });

  // Production React does not report attribute mismatches during hydration, so compare the
  // attributes the server sends with what the page has once it is interactive.
  test("<html> and the sidebar keep the server's language, direction, theme and state", async ({
    page,
    context,
  }) => {
    await setCookies(
      context,
      { "md-locale": "nl", "md-theme": "dark", "md-sidebar": "collapsed" },
      page,
    );
    const html = await (await page.request.get("/")).text();
    const serverHtml = /<html([^>]*)>/.exec(html)?.[1] ?? "";
    const serverAside = /<aside([^>]*)>/.exec(html)?.[1] ?? "";
    expect(serverHtml).toContain('lang="nl"');
    expect(serverHtml).toContain('dir="ltr"');
    expect(serverHtml).toContain('data-theme="dark"');
    expect(serverAside).toContain('data-state="collapsed"');

    await page.goto("/");
    await expect(mainNav(page)).toBeVisible();
    await page.waitForLoadState("networkidle");
    const client = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
      theme: document.documentElement.dataset.theme,
      state: document.querySelector("aside")?.dataset.state,
    }));
    expect(client).toEqual({ lang: "nl", dir: "ltr", theme: "dark", state: "collapsed" });
  });
});

test.describe("pages", () => {
  test.use({ viewport: desktop });

  test("unbuilt sections say so; unknown addresses are 404", async ({ page }) => {
    await page.goto("/pets");
    await expect(page.getByRole("heading", { level: 1, name: "Pets" })).toBeVisible();
    await expect(
      page.getByText("Pets is part of Madeora but has not been built yet."),
    ).toBeVisible();
    await expect(page).toHaveTitle("Pets · Madeora");
    expect((await page.request.get("/not-a-section")).status()).toBe(404);
    expect((await page.request.get("/trash")).status()).toBe(404);
    expect((await page.request.get("/a/b")).status()).toBe(404);
  });

  test.describe("not found", () => {
    // Opening a missing page makes the browser log the 404 response itself.
    test.use({ allowedConsoleErrors: [/status of 404/] });

    test("the not-found page is in the interface language, inside and outside the shell", async ({
      page,
      context,
    }) => {
      await setCookies(context, { "md-locale": "nl" }, page);
      for (const path of ["/not-a-section", "/a/b"]) {
        const response = await page.goto(path);
        expect(response?.status()).toBe(404);
        await expect(page.locator("html")).toHaveAttribute("lang", "nl");
        await expect(
          page.getByRole("heading", { level: 1, name: "Pagina niet gevonden" }),
        ).toBeVisible();
        await expect(page).toHaveTitle("Pagina niet gevonden · Madeora");
        await expect(page.getByText("This page could not be found")).toHaveCount(0);
      }
      // Inside the shell for a single unknown segment.
      await page.goto("/not-a-section");
      await expect(page.getByRole("navigation", { name: "Hoofdmenu" })).toBeVisible();
    });
  });
});

test.describe("small screens", () => {
  test.use({ viewport: phone });

  test("a menu replaces the sidebar; it traps focus, closes with Escape and returns focus", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(sidebar(page)).toBeHidden();
    const menuButton = page.getByRole("button", { name: "Open menu" });
    await menuButton.click();

    const dialog = page.getByRole("dialog", { name: "Menu" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("link")).toHaveText([...navNames.en]);
    // Tab stays in the menu. Past its last link the browser may move focus to its own toolbar
    // (document.body here), but never to the page behind the menu.
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      const where = await dialog.evaluate((el) =>
        el.contains(document.activeElement)
          ? "menu"
          : document.activeElement === document.body
            ? "browser"
            : "page",
      );
      expect(where).not.toBe("page");
    }
    expect(await dialog.evaluate((el) => el.matches(":modal"))).toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(menuButton).toBeFocused();
  });

  test("choosing a destination navigates and closes the menu", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("dialog", { name: "Menu" }).getByRole("link", { name: "Tasks" }).click();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
  });

  test("a click on the backdrop closes the menu", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
    await page.mouse.click(phone.width - 10, phone.height / 2);
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("widening the window to desktop size closes the menu", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
    await page.setViewportSize(desktop);
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(sidebar(page)).toBeVisible();
    await mainNav(page).getByRole("link", { name: "Tasks" }).click();
    await expect(page).toHaveURL(/\/tasks$/);
  });

  test("the page does not scroll sideways", async ({ page }) => {
    await page.goto("/settings");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      phone.width,
    );
  });
});

test.describe("right-to-left layout", () => {
  test.use({ viewport: desktop });

  async function goRtl(page: Page, path: string) {
    await page.goto(path);
    await page.evaluate(() => {
      document.documentElement.dir = "rtl";
    });
  }

  test("the shell mirrors: sidebar on the right, no sideways scrolling", async ({ page }) => {
    await goRtl(page, "/");
    const aside = await sidebar(page).boundingBox();
    const main = await page.getByRole("main").boundingBox();
    expect(aside?.x ?? 0).toBeGreaterThan(main?.x ?? 0);
    expect(Math.round((aside?.x ?? 0) + (aside?.width ?? 0))).toBe(desktop.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(desktop.width);
  });

  test("collapsed tooltips open towards the content, on the left", async ({ page, context }) => {
    await setCookies(context, { "md-sidebar": "collapsed" }, page);
    await goRtl(page, "/");
    const link = mainNav(page).getByRole("link", { name: "Tasks" });
    await link.focus();
    const tooltip = link.locator("[aria-hidden] > span");
    await expect(tooltip).toBeVisible();
    await settle(page);
    const linkBox = await link.boundingBox();
    const tipBox = await tooltip.boundingBox();
    expect((tipBox?.x ?? 0) + (tipBox?.width ?? 0)).toBeLessThanOrEqual(linkBox?.x ?? 0);
  });

  test("the small-screen menu opens from the right", async ({ page }) => {
    await page.setViewportSize(phone);
    await goRtl(page, "/");
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
    // Measure after the enter animation (a slight scale-up) has finished.
    await settle(page);
    const box = await page.getByRole("dialog", { name: "Menu" }).boundingBox();
    expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBe(phone.width);
  });
});

for (const theme of ["light", "dark"] as const) {
  test.describe(`accessibility and colours, ${theme} theme`, () => {
    for (const locale of ["en", "nl"] as const) {
      test(`dashboard and settings have no axe violations (${locale}, expanded and collapsed)`, async ({
        page,
        context,
      }) => {
        await page.setViewportSize(desktop);
        await setCookies(context, { "md-theme": theme, "md-locale": locale }, page);
        await page.goto("/");
        expect(await axeViolations(page)).toEqual([]);

        await setCookies(context, { "md-sidebar": "collapsed" }, page);
        await page.goto("/settings");
        await mainNav(page).getByRole("link").first().focus();
        expect(await axeViolations(page)).toEqual([]);
      });
    }

    test("the small-screen menu has no axe violations", async ({ page, context }) => {
      await page.setViewportSize(phone);
      await setCookies(context, { "md-theme": theme }, page);
      await page.goto("/calendar");
      await page.getByRole("button", { name: "Open menu" }).click();
      await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
      expect(await axeViolations(page)).toEqual([]);
    });

    test("the shell paints only design-token colours", async ({ page, context }) => {
      await page.setViewportSize(desktop);
      await setCookies(context, { "md-theme": theme, "md-sidebar": "collapsed" }, page);
      await page.goto("/settings");
      await mainNav(page).getByRole("link", { name: "Calendar" }).focus();
      expect(await nonTokenColours(page)).toEqual([]);
    });
  });
}
