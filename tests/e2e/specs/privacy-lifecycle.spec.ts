import { readFileSync } from "node:fs";

import { registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { createHomeFor, setGlobalProfile } from "../support/database";
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
  await expect(page.getByText("Ann's flat", { exact: true })).toBeVisible();
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
