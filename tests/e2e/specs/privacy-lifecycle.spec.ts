import { readFileSync } from "node:fs";

import { type Account, registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile, sql } from "../support/database";
import { runJobs } from "../support/jobs";

// S39 done-condition: the export half of the "Privacy lifecycle" journey (Project-entry.md):
// review settings and history, then export permitted data. Ann looks at the privacy dashboard,
// walks through the optional guided review (which changes nothing), finds it in her activity
// history, asks for a full export after confirming it's her, the background job prepares it, and
// she downloads a single ZIP with a manifest after confirming again.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
  // Requesting and downloading first ask the server, which answers 403 until Ann confirms it's her.
  allowedConsoleErrors: [/Failed to load resource: the server responded with a status of 403/],
});

test("review privacy settings and history, then export permitted data", async ({
  page,
  baseURL,
}) => {
  const ann = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(ann.email, "Ann", "#2563eb");
  createHomeFor(ann.email, "Ann's flat");
  await signIn(page, ann);

  // The privacy dashboard: scoped summaries linked to their own settings.
  await page.goto("/settings");
  await page.getByTestId("privacy-link").click();
  await expect(page.getByRole("heading", { level: 1, name: "Privacy" })).toBeVisible();
  // The Homes section names each Home (the context switcher names it too).
  await expect(
    page.getByLabel("Your Homes").getByText("Ann's flat", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Home-specific").first()).toBeVisible();
  await expect(page.getByText(/Your account is not searchable/)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // The optional guided review, by keyboard-reachable buttons only; nothing is changed.
  await page.getByTestId("privacy-review-link").click();
  await page.getByRole("button", { name: "Start the review" }).click();
  await expect(page.getByRole("heading", { name: "Your profile" })).toBeFocused();
  expect(await axeViolations(page)).toEqual([]);
  for (const next of [
    "Your Homes",
    "Connected services",
    "Sign-in and recovery",
    "Devices",
    "Your data",
  ]) {
    await page.getByRole("button", { name: "Keep as is" }).click();
    await expect(page.getByRole("heading", { name: next })).toBeVisible();
  }
  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page.getByText(/Review completed/)).toBeVisible();

  // The history shows the review.
  await page.goto("/settings/activity");
  await expect(page.getByText("Privacy review completed").first()).toBeVisible();

  // Export: All eligible data, after confirming it's her.
  await page.goto("/settings/privacy/export");
  await expect(page.getByRole("heading", { level: 1, name: "Export your data" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "All eligible data" })).toBeChecked();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Prepare export" }).click();
  const confirm = page.getByRole("form", { name: "Confirm it's you to prepare the export." });
  await confirm.getByLabel(/password/i).fill(ann.password);
  await confirm.getByRole("button", { name: "Prepare export" }).click();
  await expect(page.getByText(/Your export is being prepared/)).toBeVisible();
  const row = page.getByTestId("data-export-row").first();
  await expect(row.getByText(/Waiting to start|Being prepared/)).toBeVisible();

  // The background job prepares it (Trigger.dev in production).
  runJobs();
  await page.reload();
  await expect(row.getByText(/^Ready until /)).toBeVisible();

  // Download: confirmed again (the earlier confirmation may have lapsed), then a short link.
  const downloading = page.waitForEvent("download");
  await row.getByRole("button", { name: /^Download / }).click();
  const again = page.getByRole("form", { name: "Confirm it's you to download the export." });
  const first = await Promise.race([
    downloading.then(() => "download" as const),
    again.waitFor().then(() => "confirm" as const),
  ]);
  if (first === "confirm") {
    await again.getByLabel(/password/i).fill(ann.password);
    await again.getByRole("button", { name: "Download" }).click();
  }
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^madeora-export-\d{4}-\d{2}-\d{2}\.zip$/);
  const path = await download.path();
  const zip = readFileSync(path);
  // A ZIP (local file header) with the manifest, the readme and the account folder.
  expect(zip.subarray(0, 4).toString("hex")).toBe("504b0304");
  const names = zip.toString("latin1");
  expect(names).toContain("manifest.json");
  expect(names).toContain("README.txt");
  expect(names).toContain("account/profile.json");

  await page.reload();
  await expect(row.getByText(/^Downloaded /)).toBeVisible();
});

// S40 done-condition: the deletion half of the journey. Ann closes her Home after typing its name
// and confirming it's her; Bea, a member, can no longer open it; Ann restores it within the 30
// days. Then Bea deletes her account: every session ends, signing in again only offers to cancel
// the deletion, and cancelling brings the account back.
test("delete data with the required confirmation and recovery", async ({ page, baseURL }) => {
  const ann = await registerConfirmed(baseURL ?? "");
  const bea = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(ann.email, "Ann", "#2563eb");
  setGlobalProfile(bea.email, "Bea", "#16a34a");
  const homeId = createHomeFor(ann.email, "Pine Lane");
  addMember(homeId, bea.email, "member");

  /** Confirms it's `who` when the form appears (a recent confirmation may still count). */
  async function confirmIfAsked(who: Account, name: string, button: string, done: RegExp) {
    const form = page.getByRole("form", { name });
    const first = await Promise.race([
      page.waitForURL(done).then(() => "done" as const),
      form.waitFor().then(() => "confirm" as const),
    ]);
    if (first === "confirm") {
      await form.getByLabel(/password/i).fill(who.password);
      await form.getByRole("button", { name: button }).click();
    }
    await expect(page).toHaveURL(done);
  }

  // Ann closes the Home from its settings: the summary, the typed name, then "confirm it's you".
  await signIn(page, ann);
  await page.goto(`/homes/${homeId}/close`);
  await expect(page.getByRole("heading", { level: 1, name: /Close .*Pine Lane/ })).toBeVisible();
  await expect(page.getByTestId("close-summary")).toContainText("2 members, you included");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByTestId("close-home-name").fill("Pine");
  await page.getByRole("button", { name: "Close the Home" }).click();
  await expect(page.getByText("Type the Home's name exactly as it's written.")).toBeVisible();
  await page.getByTestId("close-home-name").fill("Pine Lane");
  await page.getByRole("button", { name: "Close the Home" }).click();
  await confirmIfAsked(
    ann,
    "Confirm it's you to close the Home.",
    "Close the Home",
    /\/settings\/closed-homes\?status=closed/,
  );
  const closed = page.getByTestId("closed-home");
  await expect(closed).toContainText("Pine Lane");
  await expect(closed).toContainText(/Deleted for good on /);
  expect(await axeViolations(page)).toEqual([]);

  // Nobody can open it now, Ann included.
  // Its pages send everyone to the start page with the "Home unavailable" notice.
  await page.goto(`/homes/${homeId}`);
  await expect(page.getByText("That Home isn't available to you.")).toBeVisible();
  await expect(page).not.toHaveURL(new RegExp(`/homes/${homeId}`));

  // Ann restores it within the 30 days.
  await page.goto("/settings/closed-homes");
  await page.getByRole("button", { name: "Restore the Home" }).click();
  await confirmIfAsked(
    ann,
    "Confirm it's you to restore the Home.",
    "Restore the Home",
    new RegExp(`/homes/${homeId}$`),
  );
  await page.goto("/settings/closed-homes");
  await expect(page.getByTestId("closed-homes-empty")).toBeVisible();
  await page.context().clearCookies();

  // Bea deletes her account.
  await signIn(page, bea);
  await page.goto("/settings/privacy");
  await page.getByTestId("privacy-delete-account-link").click();
  await expect(page.getByRole("heading", { level: 1, name: "Delete your account" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByTestId("delete-account-phrase").fill("DELETE");
  await page.getByRole("button", { name: "Delete my account" }).click();
  await confirmIfAsked(
    bea,
    "Confirm it's you to delete your account.",
    "Delete my account",
    /\/sign-in\?status=deletion_requested/,
  );
  await expect(page.getByText(/Your account will be deleted in 30 days/)).toBeVisible();

  // Signing in again only offers to cancel the deletion; cancelling brings the account back.
  await signIn(page, bea);
  await expect(page).toHaveURL(/\/reactivate$/);
  await expect(page.getByTestId("account-pending-deletion")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Cancel deletion" }).click();
  await expect(page).toHaveURL(/\/sign-in\?status=deletion_canceled/);
  await expect(page.getByText(/The deletion is cancelled/)).toBeVisible();
  await signIn(page, bea, page.url());
  await expect(page).toHaveURL(/\/settings\/activity\?/);
  await page.goto(`/homes/${homeId}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Pine Lane");
});

/** A personal published recipe and a personal all-day event of `email`; returns their ids. */
function personalItems(email: string): { recipe: string; event: string } {
  const ids = sql(
    `
    with person as (select id from auth.users where email = :'email'),
    recipe as (
      insert into private.recipes (id, owner_user_id, status, name, name_key, created_by, published_at)
      select gen_random_uuid(), id, 'published', 'Lentil soup', 'lentil soup', id, now() from person
      returning id
    ),
    event as (
      insert into private.calendar_events (id, owner_user_id, title, all_day, starts_on, ends_on,
          timezone, created_by)
      select gen_random_uuid(), id, 'Dentist', true, current_date, current_date, 'Europe/London', id from person
      returning id
    )
    select (select id from recipe) || ' ' || (select id from event);
    `,
    { email },
  );
  const [recipe = "", event = ""] = ids.split(" ");
  return { recipe, event };
}

// S40 part 2 done-condition: deleting chosen categories of personal data, and copying a personal
// item into a Home before deletion. Bea deletes her calendar after the impact preview, the
// acknowledgement, the typed word and confirming it's her. She asks to copy a recipe into Ann's
// Home, which waits for approval; Ann approves and the Home has its own copy, marked as copied from
// personal. Before deleting her account, Bea must cancel the request she still has open.
test("delete personal data by category and copy content into a Home", async ({ page, baseURL }) => {
  const ann = await registerConfirmed(baseURL ?? "");
  const bea = await registerConfirmed(baseURL ?? "");
  setGlobalProfile(ann.email, "Ann", "#2563eb");
  setGlobalProfile(bea.email, "Bea", "#16a34a");
  const homeId = createHomeFor(ann.email, "Oak Road");
  addMember(homeId, bea.email, "member");
  const items = personalItems(bea.email);

  // Bea deletes her personal calendar.
  await signIn(page, bea);
  await page.goto("/settings/privacy");
  await page.getByTestId("privacy-delete-data-link").click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Delete data by category" }),
  ).toBeVisible();
  await expect(page.getByTestId("data-deletion-not-here")).toContainText("Security activity");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByTestId("data-deletion-category-calendar").check();
  await expect(page.getByTestId("data-deletion-impact")).toContainText(
    "Nothing is deleted in your Google account.",
  );
  await page.getByTestId("data-deletion-ack-calendar").check();
  await page.getByTestId("data-deletion-phrase").fill("DELETE");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Delete 1 category" }).click();
  const confirm = page.getByRole("form", { name: "Confirm it's you to delete this data." });
  const result = page.getByTestId("data-deletion-result");
  if (
    (await Promise.race([result.waitFor(), confirm.waitFor().then(() => "confirm")])) === "confirm"
  ) {
    await confirm.getByLabel(/password/i).fill(bea.password);
    await confirm.getByRole("button", { name: "Delete 1 category" }).click();
  }
  await expect(result).toContainText("Your data was deleted.");
  await expect(page.getByTestId("data-deletion-result-calendar")).toContainText("1 item deleted");
  await page.goto(`/calendar/events/${items.event}`);
  await expect(page.getByTestId("event-page")).toHaveCount(0);

  // Bea asks to copy her recipe into the Home; as a plain member it waits for approval.
  await page.goto(`/recipes/${items.recipe}`);
  await page.getByTestId("copy-to-home-link").click();
  await expect(page.getByRole("heading", { level: 1, name: "Copy to a Home" })).toBeVisible();
  await expect(page.getByText("Needs approval in this Home")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("checkbox", { name: /Oak Road/ }).check();
  await page.getByTestId("copy-understand").check();
  await page.getByRole("button", { name: "Copy to 1 Home" }).click();
  await expect(page.getByTestId("copy-result-pending")).toContainText("waiting for approval");
  await page.goto("/settings/privacy/copies");
  await expect(page.getByTestId("my-copy-pending")).toContainText("Oak Road");
  expect(await axeViolations(page)).toEqual([]);
  await page.context().clearCookies();

  // Ann approves it from the Home's copy requests, after reading the consequences.
  await signIn(page, ann);
  await page.goto(`/homes/${homeId}/settings`);
  await page.getByTestId("home-copy-requests-link").click();
  const request = page.getByTestId("copy-request");
  await expect(request).toContainText("Lentil soup");
  await expect(request).toContainText("Asked by Bea");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/Oak Road gets its own copy/)).toBeVisible();
  await page.getByRole("button", { name: "Approve and copy" }).click();
  await expect(page.getByText("Approved. The copy is in the Home.")).toBeVisible();

  // The Home's own copy, quietly labelled.
  const copy = sql(
    `select id from private.recipes where owner_home_id = :'home'::uuid and name = 'Lentil soup';`,
    { home: homeId },
  );
  await page.goto(`/homes/${homeId}/recipes/${copy}`);
  await expect(page.getByTestId("copy-origin")).toContainText("Copied from personal");
  await page.context().clearCookies();

  // Bea asks again, then has to cancel that open request before deleting her account.
  await signIn(page, bea);
  await page.goto(`/copy-to-home?type=recipe&id=${items.recipe}`);
  await page.getByRole("checkbox", { name: /Oak Road/ }).check();
  await page.getByTestId("copy-understand").check();
  await page.getByRole("button", { name: "Copy to 1 Home" }).click();
  await expect(page.getByTestId("copy-result-pending")).toBeVisible();
  await page.goto("/settings/privacy/delete");
  const open = page.getByTestId("account-deletion-copies");
  await expect(open).toContainText("Oak Road");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByTestId("account-deletion-copies-ack").check();
  await page.getByRole("button", { name: "Cancel 1 request" }).click();
  await expect(open).toHaveCount(0);
});
