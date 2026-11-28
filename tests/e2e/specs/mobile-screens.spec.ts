import { mkdirSync, writeFileSync } from "node:fs";

import { registerConfirmed, signIn } from "../support/accounts";
import { expect, settle, test } from "../support/browser";
import { createHomeFor, setGlobalProfile } from "../support/database";
import { homeScreens, personalScreens } from "../support/screens";

// Phone layouts: every main screen at the narrowest supported width (320 px) and at a common phone
// width (390 px), on a touch device. A screen passes when the page does not scroll sideways and no
// visible control is smaller than WCAG 2.2's 24 px minimum target (2.5.8). Set MOBILE_AUDIT_DIR to
// also write a full-page screenshot and a JSON report per screen.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  hasTouch: true,
  isMobile: true,
});

interface Finding {
  overflow: { selector: string; right: number }[];
  small: { selector: string; width: number; height: number; text: string }[];
}

for (const width of [320, 390]) {
  for (const theme of width === 320 ? (["light", "dark"] as const) : (["light"] as const)) {
    test.describe(`${String(width)} px, ${theme}`, () => {
      test.use({ viewport: { width, height: 800 }, colorScheme: theme });

      test(`no sideways scrolling and no tiny controls (${String(width)} px, ${theme})`, async ({
        page,
        baseURL,
      }) => {
        test.setTimeout(10 * 60_000);
        const account = await registerConfirmed(baseURL ?? "");
        setGlobalProfile(account.email, "Ann", "#2563eb");
        const homeId = createHomeFor(account.email, "Ann's flat");
        await signIn(page, account);

        const dir = process.env.MOBILE_AUDIT_DIR;
        if (dir) mkdirSync(dir, { recursive: true });
        const paths = [...personalScreens, ...homeScreens.map((path) => `/homes/${homeId}${path}`)];
        const problems: string[] = [];
        for (const path of paths) {
          const response = await page.goto(path, { timeout: 30_000 });
          const status = response?.status() ?? 0;
          if (status >= 400) {
            problems.push(`${path}: HTTP ${String(status)}`);
            continue;
          }
          const heading = page.getByRole("heading", { level: 1 }).first();
          if (!(await heading.isVisible({ timeout: 10_000 }).catch(() => false))) {
            problems.push(`${path}: no visible level-1 heading`);
            continue;
          }
          await settle(page);
          const found = await page.evaluate((): Finding => {
            const vw = document.documentElement.clientWidth;
            const describe = (el: Element) =>
              `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${
                typeof el.className === "string" && el.className
                  ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
                  : ""
              }`;
            const visible = (el: Element) => {
              const style = getComputedStyle(el);
              if (style.visibility === "hidden" || style.display === "none") return false;
              const box = el.getBoundingClientRect();
              return box.width > 0 && box.height > 0;
            };
            const clipped = (el: Element) => {
              for (let node = el.parentElement; node; node = node.parentElement) {
                const style = getComputedStyle(node);
                if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && node !== document.body) {
                  return true;
                }
              }
              return false;
            };
            const overflow: Finding["overflow"] = [];
            if (document.documentElement.scrollWidth > vw) {
              for (const el of document.body.querySelectorAll("*")) {
                if (!visible(el) || clipped(el)) continue;
                const right = el.getBoundingClientRect().right;
                if (right > vw + 1)
                  overflow.push({ selector: describe(el), right: Math.round(right) });
              }
            }
            const small: Finding["small"] = [];
            const controls = document.querySelectorAll(
              "button, [role=button], select, input:not([type=hidden]), summary, a[href]",
            );
            for (const el of controls) {
              if (!visible(el) || el.closest("[aria-hidden=true], [inert]")) continue;
              // A link inside a sentence is exempt from the target size (WCAG 2.2, 2.5.8 "inline").
              if (el.tagName === "A" && !el.closest("nav")) {
                const parent = el.parentElement;
                if (
                  parent &&
                  parent.textContent &&
                  parent.textContent.trim() !== el.textContent.trim()
                )
                  continue;
              }
              // A checkbox or radio is tapped through its label: that is the target to measure.
              const target =
                el instanceof HTMLInputElement && /checkbox|radio/.test(el.type)
                  ? (el.closest("label") ?? el.labels?.[0] ?? el)
                  : el;
              if (el instanceof HTMLInputElement && el.classList.contains("sr-only")) continue;
              const box = target.getBoundingClientRect();
              if (box.width < 24 || box.height < 24) {
                small.push({
                  selector: describe(el),
                  width: Math.round(box.width),
                  height: Math.round(box.height),
                  text: (el.getAttribute("aria-label") ?? el.textContent).trim().slice(0, 40),
                });
              }
            }
            return { overflow: overflow.slice(0, 5), small: small.slice(0, 8) };
          });
          if (dir) {
            const name = `${path.replace(homeId, "HOME").replace(/\//g, "_") || "_"}-${String(width)}-${theme}`;
            writeFileSync(`${dir}/${name}.json`, JSON.stringify(found, null, 1));
            await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
          }
          if (found.overflow.length > 0) {
            problems.push(`${path}: scrolls sideways: ${JSON.stringify(found.overflow)}`);
          }
          if (found.small.length > 0) {
            problems.push(`${path}: controls under 24 px: ${JSON.stringify(found.small)}`);
          }
        }
        expect(problems).toEqual([]);
      });
    });
  }
}
