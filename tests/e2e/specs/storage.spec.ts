import type { Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, sql } from "../support/database";

// S15: file storage, with the avatar as its first user. Uploads go to the local S3 stand-in that
// Playwright starts (playwright.config.ts); every byte is checked by the real finalize step and
// every view is authorized by the real database. Each test makes its own accounts.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 800 },
  // The browser logs the deliberate refusals (a refused upload or an unauthorized view).
  allowedConsoleErrors: [/status of (404|409|422)/],
});

// A tiny real PNG (one pixel); the server turns it into a 512×512 WebP.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const CONTENT_PATH = /^\/api\/v1\/files\/([0-9a-f-]{36})\/content$/;

async function newAdult(page: Page, baseURL: string | undefined): Promise<Account> {
  const account = await registerConfirmed(baseURL ?? "");
  await signIn(page, account);
  return account;
}

async function choosePicture(page: Page, scope: "global" | "home", file = PNG, name = "me.png") {
  await page
    .getByTestId(`avatar-setting-${scope}`)
    .getByLabel("Choose a picture")
    .setInputFiles({ name, mimeType: "image/png", buffer: file });
}

/** The file id behind the avatar picture shown in `scope`. */
async function shownFileId(page: Page, scope: "global" | "home"): Promise<string> {
  const src = await page
    .getByTestId(`avatar-setting-${scope}`)
    .getByTestId("member-avatar-image")
    .getAttribute("src");
  const id = CONTENT_PATH.exec(src ?? "")?.[1];
  if (!id) throw new Error(`no avatar picture shown: ${String(src)}`);
  return id;
}

/** Whether the picture really loaded (followed the redirect to storage and decoded). */
async function imageLoaded(page: Page, testId = "member-avatar-image"): Promise<boolean> {
  const image = page.getByTestId(testId).first();
  await image.scrollIntoViewIfNeeded();
  await expect(image).toHaveJSProperty("complete", true);
  return image.evaluate((element) => (element as HTMLImageElement).naturalWidth === 512);
}

function contentStatus(page: Page, fileId: string): Promise<number> {
  return page.request
    .get(`/api/v1/files/${fileId}/content`, { maxRedirects: 0 })
    .then((response) => response.status());
}

test("a profile picture is uploaded, shown to Home members and refused to everyone else", async ({
  page,
  browser,
  baseURL,
}) => {
  const ward = await newAdult(page, baseURL);
  const homeId = createHomeFor(ward.email, "Thuis");

  await page.goto("/settings");
  await expect(page.getByTestId("avatar-state")).toHaveText(/No picture yet/);
  await choosePicture(page, "global");
  await expect(page.getByTestId("avatar-done")).toHaveText("Picture saved.");
  await expect(page.getByTestId("avatar-state")).toHaveText(/This is your picture/);
  const fileId = await shownFileId(page, "global");
  expect(await imageLoaded(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  // The view is a short redirect that no cache may keep, to a GET-only signed link.
  const view = await page.request.get(`/api/v1/files/${fileId}/content`, { maxRedirects: 0 });
  expect(view.status()).toBe(302);
  expect(view.headers()["cache-control"]).toBe("private, no-store");
  expect(view.headers().location).toContain("X-Amz-Expires=60");

  // A member of the same Home sees it in the directory.
  const memberContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const memberPage = await memberContext.newPage();
  const member = await newAdult(memberPage, baseURL);
  addMember(homeId, member.email, "member");
  await memberPage.goto(`/homes/${homeId}/members`);
  const wardRow = memberPage
    .getByTestId("directory-member")
    .filter({ has: memberPage.getByTestId("member-avatar-image") });
  await expect(wardRow).toHaveCount(1);
  expect(await imageLoaded(memberPage)).toBe(true);
  expect(await contentStatus(memberPage, fileId)).toBe(302);

  // Someone in another Home only (cross-Home), and a guessed id, get the same bare 404.
  const strangerContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const strangerPage = await strangerContext.newPage();
  const stranger = await newAdult(strangerPage, baseURL);
  createHomeFor(stranger.email, "Buren");
  expect(await contentStatus(strangerPage, fileId)).toBe(404);
  expect(await contentStatus(strangerPage, "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01")).toBe(404);

  // Leaving the Home ends access at once.
  sql(
    `delete from public.home_memberships
     where home_id = :'home'::uuid and user_id = (select id from auth.users where email = :'email');`,
    { home: homeId, email: member.email },
  );
  expect(await contentStatus(memberPage, fileId)).toBe(404);

  // Signed out, nothing.
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const anonymousStatus = await anonymous.request
    .get(`${baseURL ?? ""}/api/v1/files/${fileId}/content`, { maxRedirects: 0 })
    .then((response) => response.status());
  expect(anonymousStatus).toBe(401);
  await Promise.all([memberContext.close(), strangerContext.close(), anonymous.close()]);
});

test("a Home can show its own picture of a person, and go back to the global one", async ({
  page,
  baseURL,
}) => {
  const ward = await newAdult(page, baseURL);
  const homeId = createHomeFor(ward.email, "Thuis");
  await page.goto("/settings");
  await choosePicture(page, "global");
  await expect(page.getByTestId("avatar-done")).toBeVisible();
  const globalId = await shownFileId(page, "global");

  await page.goto(`/homes/${homeId}/profile`);
  await expect(page.getByTestId("avatar-state")).toHaveText("This Home shows your global picture.");
  expect(await shownFileId(page, "home")).toBe(globalId);
  await choosePicture(page, "home");
  await expect(page.getByTestId("avatar-done")).toHaveText("Picture saved.");
  await expect(page.getByTestId("avatar-state")).toHaveText(
    "This Home shows its own picture of you.",
  );
  const homeFileId = await shownFileId(page, "home");
  expect(homeFileId).not.toBe(globalId);
  expect(await axeViolations(page)).toEqual([]);

  await page.goto(`/homes/${homeId}/members`);
  await expect(page.getByTestId("member-avatar-image")).toHaveAttribute(
    "src",
    `/api/v1/files/${homeFileId}/content`,
  );

  await page.goto(`/homes/${homeId}/profile`);
  await page.getByRole("button", { name: "Use my global picture" }).click();
  await expect(page.getByTestId("avatar-done")).toHaveText(
    "This Home now uses your global picture.",
  );
  await expect(page.getByTestId("avatar-state")).toHaveText("This Home shows your global picture.");
  expect(await shownFileId(page, "home")).toBe(globalId);
});

test("a file that is not really a picture is refused after upload", async ({ page, baseURL }) => {
  await newAdult(page, baseURL);
  await page.goto("/settings");
  await choosePicture(
    page,
    "global",
    Buffer.from("just some text pretending to be a picture"),
    "notes.png",
  );
  await expect(page.getByTestId("avatar-error")).toHaveText(/isn't a picture we can use/);
  await expect(page.getByTestId("avatar-state")).toHaveText(/No picture yet/);
  await expect(page.getByTestId("member-avatar-image")).toHaveCount(0);
});

test("full storage refuses new uploads, says what still works and warns once", async ({
  page,
  baseURL,
}) => {
  const ward = await newAdult(page, baseURL);
  await page.goto("/settings");
  await choosePicture(page, "global");
  await expect(page.getByTestId("avatar-done")).toBeVisible();

  // The owner lowers the allowance to exactly what is stored: the pool is full.
  sql(
    `select public.set_storage_allowance(u.id, null,
       (select sum(f.size_bytes) from private.stored_files f
        where f.created_by = u.id and f.status = 'ready')::bigint)
     from auth.users u where u.email = :'email';`,
    { email: ward.email },
  );

  await page.reload();
  await choosePicture(page, "global");
  await expect(page.getByTestId("avatar-error")).toHaveText(
    "Your personal storage is full. Free some space, then try again.",
  );
  await page.getByRole("link", { name: "Open your storage" }).click();
  await expect(page).toHaveURL(/\/settings\/storage$/);
  await expect(page.getByRole("heading", { level: 1, name: "Storage" })).toBeVisible();
  await expect(page.getByTestId("storage-summary")).toHaveText(/\(100%\)/);
  await expect(page.getByTestId("storage-full")).toHaveText(/everything else keep working/);
  expect(await axeViolations(page)).toEqual([]);

  // The 95% notice arrived once, in the notification centre.
  await page.goto("/notifications");
  await expect(page.getByTestId("notification")).toHaveCount(1);
  await expect(page.getByTestId("notification")).toHaveText(/Your storage is almost full \(95%\)/);
});

test("a Home's storage is shown to its Owner and explained to other members", async ({
  page,
  browser,
  baseURL,
}) => {
  const ward = await newAdult(page, baseURL);
  const homeId = createHomeFor(ward.email, "Thuis");
  await page.goto(`/homes/${homeId}/settings`);
  await page.getByTestId("home-storage-link").click();
  await expect(page).toHaveURL(new RegExp(`/homes/${homeId}/storage$`));
  await expect(page.getByTestId("storage-usage-home")).toBeVisible();
  await expect(page.getByTestId("storage-summary")).toHaveText("0 byte of 5 GB used (0%)");
  expect(await axeViolations(page)).toEqual([]);

  const memberContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const memberPage = await memberContext.newPage();
  const member = await newAdult(memberPage, baseURL);
  addMember(homeId, member.email, "member");
  await memberPage.goto(`/homes/${homeId}/settings`);
  await expect(memberPage.getByTestId("home-storage-link")).toHaveCount(0);
  await memberPage.goto(`/homes/${homeId}/storage`);
  await expect(memberPage.getByText("Only the Home's storage managers see this")).toBeVisible();
  await expect(memberPage.getByTestId("storage-usage-home")).toHaveCount(0);
  expect(await axeViolations(memberPage)).toEqual([]);
  await memberContext.close();
});
