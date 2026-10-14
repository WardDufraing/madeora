import { randomUUID } from "node:crypto";

import { deriveAccent } from "@madeora/design-tokens";
import type { Page } from "@playwright/test";

import { registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile } from "../support/database";

// S11: the member directory, Home-specific names and personal accents. Alice owns a Home where Bob
// is a Member; Carol has a Home of her own. Each test makes its own accounts. Memberships and the
// other people's saved names are set up in the database, so each test drives only Alice's screens.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 800 },
});

/** Signs a new adult in and creates their own Home through the form. */
async function adultWithHome(page: Page, baseURL: string | undefined, homeName: string) {
  const account = await registerConfirmed(baseURL ?? "");
  await signIn(page, account);
  await page.goto("/homes/new");
  await page.getByRole("textbox", { name: /Home name/ }).fill(homeName);
  await page.getByRole("button", { name: "Create Home" }).click();
  await page.waitForURL(/\/homes\/[0-9a-f-]{36}$/);
  return { account, homeId: page.url().split("/").pop() ?? "" };
}

/** The accent colour the page currently draws primary buttons with, as `rgb(...)`. */
function pageAccent(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--md-color-accent)";
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });
}

function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${String((value >> 16) & 255)}, ${String((value >> 8) & 255)}, ${String(value & 255)})`;
}

const memberNames = (page: Page) => page.getByTestId("member-name");

test("members see each other's Home names and colours, overrides stay in their Home, and resets inherit again", async ({
  page,
  baseURL,
  browser,
}) => {
  const { homeId } = await adultWithHome(page, baseURL, "Thuis");
  const bob = await registerConfirmed(baseURL ?? "");
  addMember(homeId, bob.email, "member");
  setGlobalProfile(bob.email, "Bob", "#16a34a");
  const carol = await registerConfirmed(baseURL ?? "");
  const carolsHome = createHomeFor(carol.email, "Elders");
  setGlobalProfile(carol.email, "Carol", "#dc2626");

  // Alice's global name and accent, in Settings.
  await page.goto("/settings");
  await page.getByRole("textbox", { name: /Display name/ }).fill("Alice");
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Display name saved.")).toBeVisible();
  const accentCard = page.getByRole("region", { name: "Accent colour" });
  await accentCard.getByRole("radio", { name: "Teal", exact: true }).check();
  await accentCard.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Accent colour saved.")).toBeVisible();
  await expect.poll(() => pageAccent(page)).toBe(rgb(deriveAccent("#0d9488", "light").accent));

  // The directory: both members, Alice marked as herself, Carol nowhere.
  await page.goto(`/homes/${homeId}`);
  await page.getByTestId("members-link").click();
  await page.waitForURL(`**/homes/${homeId}/members`);
  await expect(memberNames(page)).toHaveText(["Alice (you)", "Bob"]);
  await expect(page.getByTestId("member-count")).toHaveText("2 members");
  await expect(page.getByText("Carol")).toHaveCount(0);

  // A nickname and a different colour, in this Home only.
  await page.getByRole("link", { name: "Edit how you appear" }).click();
  await page.waitForURL(`**/homes/${homeId}/profile`);
  await page.getByRole("textbox", { name: /Nickname/ }).fill("Ali");
  await page.getByTestId("nickname-form").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Nickname saved.")).toBeVisible();
  await page.getByRole("radio", { name: "Use a different colour in this Home" }).check();
  await page.getByRole("radio", { name: "Green", exact: true }).check();
  // Bob is green too: a warning with suggestions, which does not block saving.
  await expect(page.getByTestId("colour-clash")).toContainText("same colour");
  await page.getByRole("radio", { name: "Blue", exact: true }).check();
  await expect(page.getByTestId("colour-clash")).toHaveCount(0);
  await page.getByRole("button", { name: "Save colour" }).click();
  await expect(page.getByText("Colour for this Home saved.")).toBeVisible();
  await expect.poll(() => pageAccent(page)).toBe(rgb(deriveAccent("#2563eb", "light").accent));

  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    expect(await axeViolations(page), `profile page, ${theme}`).toEqual([]);
  }

  // Personal keeps the global accent.
  await page.goto("/?context=personal");
  await expect.poll(() => pageAccent(page)).toBe(rgb(deriveAccent("#0d9488", "light").accent));

  // Bob sees Alice's Home presentation, not her global name; nothing of Carol's Home.
  const bobContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const bobPage = await bobContext.newPage();
  await signIn(bobPage, bob);
  await bobPage.goto(`/homes/${homeId}/members`);
  await expect(memberNames(bobPage)).toHaveText(["Ali", "Bob (you)"]);
  await bobPage.goto(`/homes/${carolsHome}/members`);
  await expect(bobPage.getByText("That Home isn't available to you.")).toBeVisible();
  await expect(bobPage.getByText("Carol")).toHaveCount(0);

  // A global change reaches only what still inherits: the colour here stays blue, and once the
  // nickname is removed, the new global name shows.
  await page.goto("/settings");
  await page.getByRole("textbox", { name: /Display name/ }).fill("Alicia");
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Display name saved.")).toBeVisible();
  await bobPage.goto(`/homes/${homeId}/members`);
  await expect(memberNames(bobPage)).toHaveText(["Ali", "Bob (you)"]);

  await page.goto(`/homes/${homeId}/profile`);
  await page.getByRole("button", { name: "Remove nickname" }).click();
  await expect(page.getByText("Nickname removed.")).toBeVisible();
  await expect.poll(() => pageAccent(page)).toBe(rgb(deriveAccent("#2563eb", "light").accent));
  await bobPage.goto(`/homes/${homeId}/members`);
  await expect(memberNames(bobPage)).toHaveText(["Alicia", "Bob (you)"]);
  await bobContext.close();
});

test("the directory sorts and filters, tells same-named members apart, and is accessible", async ({
  page,
  baseURL,
}) => {
  const { account, homeId } = await adultWithHome(page, baseURL, "Thuis");
  setGlobalProfile(account.email, "Sam", "#2563eb");
  for (const [name, role] of [
    ["sam", "member"],
    ["Robin", "administrator"],
  ] as const) {
    const other = await registerConfirmed(baseURL ?? "");
    addMember(homeId, other.email, role);
    setGlobalProfile(other.email, name, "#2563eb");
  }

  await page.goto(`/homes/${homeId}/members`);
  await expect(memberNames(page)).toHaveText(["Sam (you)", "Robin", "sam"]);
  // Two people called Sam, both blue: told apart by the date they joined, not by colour.
  await expect(page.getByTestId("member-qualifier")).toHaveCount(2);

  await page.getByRole("combobox", { name: "Sort by" }).selectOption("name");
  await page.getByRole("checkbox", { name: "Member" }).check();
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForURL(/sort=name/);
  await expect(memberNames(page)).toHaveText(["sam"]);
  await expect(page.getByTestId("member-count")).toHaveText("Showing 1 of 3 members");

  await page.getByRole("checkbox", { name: "Member" }).uncheck();
  await page.getByRole("checkbox", { name: "Administrator" }).check();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(memberNames(page)).toHaveText(["Robin"]);
  await page.getByRole("link", { name: "Show everyone" }).first().click();
  await page.waitForURL(`**/homes/${homeId}/members`);
  await expect(memberNames(page)).toHaveCount(3);

  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    expect(await axeViolations(page), `directory, ${theme}`).toEqual([]);
  }
  // Narrow screens keep every member readable.
  await page.setViewportSize({ width: 375, height: 740 });
  expect(await axeViolations(page), "directory, phone").toEqual([]);
});

test.describe("refused requests", () => {
  // The browser logs the deliberate 404 answers.
  test.use({ allowedConsoleErrors: [/status of 404/] });

  test("nobody edits a profile in a Home they do not belong to", async ({ page, baseURL }) => {
    await adultWithHome(page, baseURL, "Thuis");
    const other = await registerConfirmed(baseURL ?? "");
    const otherHome = createHomeFor(other.email, "Buren");
    const patch = (homeId: string) =>
      page.evaluate(async (id) => {
        const response = await fetch(`/api/v1/homes/${id}/profile`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nickname: "Intruder" }),
        });
        return response.status;
      }, homeId);
    expect(await patch(otherHome)).toBe(404);
    expect(await patch(randomUUID())).toBe(404);
    await page.goto(`/homes/${otherHome}/profile`);
    await expect(page.getByText("That Home isn't available to you.")).toBeVisible();
  });
});
