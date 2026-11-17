import { readdirSync } from "node:fs";
import { join } from "node:path";

import { registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { createHomeFor, setGlobalProfile } from "../support/database";
import { excludedScreens, homeScreens, personalScreens } from "../support/screens";

// S48: axe on every main screen. One account that owns a Home walks every screen that needs no
// record id, in both themes. A screen passes when it renders a level-1 heading and axe finds no
// violation (including colour contrast). Screens with an id (one task, one recipe) are checked in
// their module's own spec; sign-in, the child sign-in, the Household Display and the child space
// are checked in auth, child-sign-in and display specs.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
});

// Guard against drift: every id-free page the app has must be on the list (or excluded on purpose).
test("the screen list covers every page without a record id", () => {
  const root = join(process.cwd(), "..", "..", "apps", "web", "src", "app", "(app)");
  const found: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}/${entry.name}`);
      else if (entry.name === "page.tsx") found.push(rel);
    }
  };
  walk(root, "");
  const listed = new Set<string>([
    ...personalScreens.map((path) => (path === "/" ? "" : path)),
    ...homeScreens.map((path) => `/homes/[homeId]${path}`),
    ...excludedScreens,
  ]);
  const missing = found.filter(
    (path) => !listed.has(path) && !path.replace("/homes/[homeId]", "").includes("["),
  );
  expect(missing, "pages missing from support/screens.ts").toEqual([]);
});

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme: theme });

    test(`every personal and Home screen has a heading and no axe violations (${theme})`, async ({
      page,
      baseURL,
    }) => {
      test.setTimeout(30 * 60_000);
      const account = await registerConfirmed(baseURL ?? "");
      setGlobalProfile(account.email, "Ann", "#2563eb");
      const homeId = createHomeFor(account.email, "Ann's flat");
      await signIn(page, account);

      expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(
        theme === "dark",
      );
      const paths = [...personalScreens, ...homeScreens.map((path) => `/homes/${homeId}${path}`)];
      const problems: string[] = [];
      for (const path of paths) {
        const response = await page.goto(path);
        const status = response?.status() ?? 0;
        if (status >= 400) {
          problems.push(`${path}: HTTP ${String(status)}`);
          continue;
        }
        if (
          (await page.getByRole("heading", { level: 1 }).count()) === 0 &&
          (await page.getByRole("main").count()) === 0
        ) {
          problems.push(`${path}: no main landmark and no level-1 heading`);
          continue;
        }
        const heading = page.getByRole("heading", { level: 1 }).first();
        if (!(await heading.isVisible({ timeout: 10_000 }).catch(() => false))) {
          problems.push(`${path}: no visible level-1 heading`);
          continue;
        }
        const violations = await axeViolations(page);
        if (violations.length > 0) problems.push(`${path}: ${violations.join("; ")}`);
      }
      expect(problems).toEqual([]);
    });
  });
}
