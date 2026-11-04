import type { Browser, Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile, sql } from "../support/database";

// S31: "Pet profile and medical history". A pet starts with only its name; medical information is
// visible only to members granted medical access, which takes effect on their next request. Files
// go to the local S3 stand-in and are checked by the real finalize step. Each test makes its own
// accounts.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
  // The browser logs the deliberate refusals (a revoked member's request).
  allowedConsoleErrors: [/status of (403|404)/],
});

const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

function isoDaysAhead(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function newAdult(page: Page, baseURL: string | undefined, name: string): Promise<Account> {
  const account = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(account.email, name, "#2563eb");
  await signIn(page, account);
  return account;
}

async function otherAdult(
  browser: Browser,
  baseURL: string | undefined,
  name: string,
): Promise<{ page: Page; account: Account; close: () => Promise<void> }> {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    locale: "en-GB",
    timezoneId: "Europe/London",
  });
  const page = await context.newPage();
  const account = await newAdult(page, baseURL, name);
  return { page, account, close: () => context.close() };
}

function membershipId(homeId: string, email: string): string {
  return sql(
    `select m.id from public.home_memberships m join auth.users u on u.id = m.user_id
     where m.home_id = :'home'::uuid and u.email = :'email';`,
    { home: homeId, email },
  );
}

async function setAccess(page: Page, homeId: string, membership: string, level: string) {
  await page.goto(`/homes/${homeId}/members/${membership}`);
  await page.getByTestId("pet-access-level").selectOption(level);
  await page.getByTestId("pet-access-save").click();
  await expect(page.getByRole("status").filter({ hasText: "was saved" })).toBeVisible();
}

test("Pet profile and medical history: add, fill in, record, grant, revoke", async ({
  page,
  browser,
  baseURL,
}) => {
  test.slow();
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  const bea = await otherAdult(browser, baseURL, "Bea");
  addMember(homeId, bea.account.email, "member");
  const cleo = await otherAdult(browser, baseURL, "Cleo");
  addMember(homeId, cleo.account.email, "member");

  // The Owner adds a pet with only its name.
  await page.goto(`/homes/${homeId}/pets`);
  await page.getByTestId("pet-new").click();
  await page.getByTestId("pet-name").fill("Miso");
  await page.getByTestId("pet-new-save").click();
  await expect(page).toHaveURL(/\/pets\/[0-9a-f-]{36}$/);
  const petUrl = page.url();
  await expect(page.getByTestId("pet-title")).toHaveText("Miso");

  // Part of the profile: species, breed Unknown, weight.
  await page.getByTestId("pet-edit").click();
  await page.getByTestId("pet-field-species").selectOption("cat");
  await page.getByTestId("pet-field-breed-unknown").check();
  await page.getByTestId("pet-field-weight").fill("4,2");
  await page.getByTestId("pet-profile-save").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByTestId("pet-breed")).toHaveText("Unknown");

  // Allergies None.
  await page.getByTestId("pet-medical-edit").click();
  await page.getByTestId("pet-allergies-state").selectOption("none");
  await page.getByTestId("pet-medical-save").click();
  await expect(page.getByTestId("pet-allergies")).toHaveText("None");
  await expect(page.getByTestId("pet-medications")).toHaveText("Not entered");

  // A vaccination with its certificate.
  await page.getByTestId("pet-entry-new").click();
  await page.getByTestId("pet-entry-type").selectOption("vaccination");
  await page.getByTestId("pet-entry-title").fill("Rabies booster");
  await page.getByTestId("pet-entry-save").click();
  await expect(page.getByTestId("pet-entry-heading")).toHaveText("Rabies booster");
  await page
    .getByTestId("pet-attachment-input")
    .setInputFiles({ name: "certificate.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.getByTestId("pet-attachment-link")).toHaveText("certificate.pdf");

  // A future vet visit is an upcoming appointment, apart from the history.
  await page.goto(petUrl);
  await page.getByTestId("pet-entry-new").click();
  await page.getByTestId("pet-entry-type").selectOption("vet_visit");
  await page.getByTestId("pet-entry-date").fill(isoDaysAhead(30));
  await page.getByTestId("pet-entry-title").fill("Dental check");
  await page.getByTestId("pet-entry-save").click();
  await expect(page.getByTestId("pet-entry-heading")).toHaveText("Dental check");
  await page.goto(petUrl);
  await expect(page.getByTestId("pet-upcoming")).toContainText("Dental check");
  await expect(page.getByTestId("pet-history")).toContainText("Rabies booster");
  await expect(page.getByTestId("pet-history")).not.toContainText("Dental check");
  expect(await axeViolations(page)).toEqual([]);

  // Before any grant, a Member sees the profile and nothing medical.
  await bea.page.goto(petUrl);
  await expect(bea.page.getByTestId("pet-title")).toHaveText("Miso");
  await expect(bea.page.getByTestId("pet-medical")).toHaveCount(0);

  // The Owner grants Bea medical view: she reads the entry and its document, without edit controls.
  await setAccess(page, homeId, membershipId(homeId, bea.account.email), "view");
  await bea.page.reload();
  await expect(bea.page.getByTestId("pet-history")).toContainText("Rabies booster");
  await expect(bea.page.getByTestId("pet-medical-edit")).toHaveCount(0);
  await expect(bea.page.getByTestId("pet-entry-new")).toHaveCount(0);
  await bea.page.getByTestId("pet-history").getByRole("link", { name: "Rabies booster" }).click();
  await expect(bea.page.getByTestId("pet-attachment-link")).toHaveText("certificate.pdf");
  await expect(bea.page.getByTestId("pet-entry-edit")).toHaveCount(0);
  await expect(bea.page.getByTestId("pet-attachment-add")).toHaveCount(0);
  const entryUrl = bea.page.url();
  const href = await bea.page.getByTestId("pet-attachment-link").getAttribute("href");
  expect((await bea.page.request.get(href ?? "", { maxRedirects: 0 })).status()).toBe(302);
  expect(await axeViolations(bea.page)).toEqual([]);

  // Revoking hides it on her next request: the entry, its document and the section.
  await setAccess(page, homeId, membershipId(homeId, bea.account.email), "none");
  expect((await bea.page.request.get(href ?? "", { maxRedirects: 0 })).status()).toBe(404);
  await bea.page.goto(entryUrl);
  await expect(bea.page.getByTestId("pet-entry-heading")).toHaveCount(0);
  await bea.page.goto(petUrl);
  await expect(bea.page.getByTestId("pet-title")).toHaveText("Miso");
  await expect(bea.page.getByTestId("pet-medical")).toHaveCount(0);

  // A Member who never had access sees the profile without any medical section.
  await cleo.page.goto(petUrl);
  await expect(cleo.page.getByTestId("pet-title")).toHaveText("Miso");
  await expect(cleo.page.getByTestId("pet-breed")).toHaveText("Unknown");
  await expect(cleo.page.getByTestId("pet-medical")).toHaveCount(0);
  await expect(cleo.page.getByText("Allergies")).toHaveCount(0);
  await expect(cleo.page.getByTestId("pet-edit")).toHaveCount(0);

  await bea.close();
  await cleo.close();
});
