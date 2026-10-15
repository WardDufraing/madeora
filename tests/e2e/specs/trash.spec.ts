import type { Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, removeMember, sql } from "../support/database";

// S16: trash and recovery. The deleted items are the database's reference "sample" record type
// (private.trash_samples), created and deleted here the way a module's own delete function would
// (private.trash_sample_delete): real modules arrive in later steps. Everything the page and the
// routes do is the real thing, against the real database. Each test makes its own accounts.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 800 },
  // The browser logs the deliberate refusals (a Home the person is not in).
  allowedConsoleErrors: [/status of (404|409)/],
});

async function newAdult(page: Page, baseURL: string | undefined): Promise<Account> {
  const account = await registerConfirmed(baseURL ?? "");
  await signIn(page, account);
  return account;
}

/** A sample item (personal, or in a Home), optionally in a slot. Returns its id. */
function createSample(
  ownerEmail: string,
  name: string,
  options: { homeId?: string; slot?: string } = {},
): string {
  return sql(
    `insert into private.trash_samples (owner_user_id, owner_home_id, name, slot, created_by)
     select case when :'home' = '' then u.id end, nullif(:'home', '')::uuid, :'name',
       nullif(:'slot', ''), u.id
     from auth.users u where u.email = :'email'
     returning id;`,
    { email: ownerEmail, name, home: options.homeId ?? "", slot: options.slot ?? "" },
  );
}

/** Deletes a sample as `actorEmail`, which puts it in the trash. */
function deleteSample(actorEmail: string, sampleId: string): void {
  sql(
    `select private.trash_sample_delete((select id from auth.users where email = :'email'), :'id'::uuid);`,
    { email: actorEmail, id: sampleId },
  );
}

function sampleState(sampleId: string): string {
  return sql(
    `select coalesce((select case when deleted_at is null then 'active' else 'deleted' end
       from private.trash_samples where id = :'id'::uuid), 'gone');`,
    { id: sampleId },
  );
}

test("personal trash: list, restore, a conflict, bulk, delete permanently and empty", async ({
  page,
  baseURL,
}) => {
  const ward = await newAdult(page, baseURL);
  const note = createSample(ward.email, "Grocery note");
  const draft = createSample(ward.email, "Draft plan");
  const taken = createSample(ward.email, "Slot holder", { slot: "front" });
  const blocker = createSample(ward.email, "Slot blocker");
  const gone = createSample(ward.email, "Throw away");
  for (const id of [note, draft, taken, gone]) deleteSample(ward.email, id);
  sql(`update private.trash_samples set slot = 'front' where id = :'id'::uuid;`, { id: blocker });

  // Reached from personal settings, not the sidebar.
  await page.goto("/settings");
  await page.getByTestId("trash-link").click();
  await expect(page).toHaveURL(/\/settings\/trash$/);
  await expect(page.getByRole("heading", { level: 1, name: "Trash" })).toBeVisible();
  await expect(page.getByTestId("trash-entry")).toHaveCount(4);
  await expect(page.getByTestId("trash-entry").first()).toContainText("Recoverable until");
  expect(await axeViolations(page)).toEqual([]);
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await axeViolations(page)).toEqual([]);
  await page.emulateMedia({ colorScheme: "light" });

  // Restore one with the keyboard: Tab to its checkbox, Space, Tab on to the button, Enter.
  await page.getByLabel(/Grocery note/).focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("trash-restore")).toHaveText("Restore 1 selected item");
  await page.getByTestId("trash-restore").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("trash-result")).toContainText("1 item restored.");
  await expect(page.getByTestId("trash-entry")).toHaveCount(3);
  expect(sampleState(note)).toBe("active");

  // A conflict: nothing changes until the person chooses.
  await page.getByLabel(/Slot holder/).check();
  await page.getByTestId("trash-restore").click();
  await expect(page.getByTestId("trash-conflict")).toContainText(
    "Another item now uses the place this item had.",
  );
  await expect(page.getByTestId("trash-result")).toContainText("needs your choice");
  expect(sampleState(taken)).toBe("deleted");
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole("button", { name: "Restore without its place" }).click();
  await expect(page.getByTestId("trash-conflict")).toHaveCount(0);
  await expect(page.getByTestId("trash-entry")).toHaveCount(2);
  expect(sampleState(taken)).toBe("active");
  expect(
    sql(`select slot is null from private.trash_samples where id = :'id'::uuid;`, { id: taken }),
  ).toBe("t");

  // Filters: a past deletion window finds nothing; clearing brings everything back.
  await page.getByLabel("Deleted until").fill("2020-01-01");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("Nothing matches these filters")).toBeVisible();
  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(page.getByTestId("trash-entry")).toHaveCount(2);

  // Delete permanently: cancel keeps it, confirm removes it for good.
  await page.getByLabel(/Throw away/).check();
  await page.getByTestId("trash-delete").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Delete this item permanently?");
  await expect(dialog).toContainText("cannot be recovered through Madeora");
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(sampleState(gone)).toBe("deleted");
  await page.getByTestId("trash-delete").click();
  await page.getByTestId("trash-confirm-delete").click();
  await expect(page.getByTestId("trash-result")).toContainText("1 item deleted permanently.");
  expect(sampleState(gone)).toBe("gone");

  // Empty trash.
  await expect(page.getByTestId("trash-entry")).toHaveCount(1);
  await page.getByTestId("trash-empty").click();
  await expect(page.getByRole("dialog")).toContainText("Empty the trash?");
  await page.getByTestId("trash-confirm-empty").click();
  await expect(page.getByText("The trash is empty")).toBeVisible();
  expect(sampleState(draft)).toBe("gone");
});

test("Home trash: members see their own deletions, the Owner sees all, strangers nothing", async ({
  page,
  browser,
  baseURL,
}) => {
  const owner = await newAdult(page, baseURL);
  const homeId = createHomeFor(owner.email, "Thuis");

  const memberContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const memberPage = await memberContext.newPage();
  const member = await newAdult(memberPage, baseURL);
  addMember(homeId, member.email, "member");

  const strangerContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const strangerPage = await strangerContext.newPage();
  await newAdult(strangerPage, baseURL);

  const byOwner = createSample(owner.email, "Owner's item", { homeId });
  const byMember = createSample(owner.email, "Member's item", { homeId });
  const personal = createSample(member.email, "Member private");
  deleteSample(owner.email, byOwner);
  deleteSample(member.email, byMember);
  deleteSample(member.email, personal);
  const url = `/homes/${homeId}/trash`;

  // The Owner sees everything in the Home trash, and nothing of anybody's personal trash.
  await page.goto(`/homes/${homeId}/settings`);
  await page.getByTestId("home-trash-link").click();
  await expect(page).toHaveURL(new RegExp(`${url}$`));
  await expect(page.getByTestId("trash-entry")).toHaveCount(2);
  await expect(page.getByText("Member private")).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);

  // The member sees only what they deleted, and their own personal trash is separate.
  await memberPage.goto(url);
  await expect(memberPage.getByTestId("trash-entry")).toHaveCount(1);
  await expect(memberPage.getByTestId("trash-entry")).toContainText("Member's item");
  await expect(memberPage.getByTestId("trash-entry")).toContainText("Deleted by you");
  await memberPage.goto("/settings/trash");
  await expect(memberPage.getByTestId("trash-entry")).toHaveCount(1);
  await expect(memberPage.getByTestId("trash-entry")).toContainText("Member private");

  // The member cannot reach the Owner's entry, even by guessing its id through the API.
  const ownerEntry = sql(`select id from private.trash_entries where subject_id = :'id'::uuid;`, {
    id: byOwner,
  });
  const forged = await memberPage.request.post("/api/v1/trash/restore", {
    data: { entryIds: [ownerEntry] },
    headers: { origin: baseURL ?? "" },
  });
  expect(forged.status()).toBe(200);
  expect(((await forged.json()) as { results: { outcome: string }[] }).results[0]?.outcome).toBe(
    "not_found",
  );
  expect(sampleState(byOwner)).toBe("deleted");

  // A stranger gets nothing of this Home, from the page or the API.
  await strangerPage.goto(url);
  await expect(strangerPage.getByText("Owner's item")).toHaveCount(0);
  await expect(strangerPage.getByText("Member's item")).toHaveCount(0);
  const listing = await strangerPage.request.get(`/api/v1/trash?homeId=${homeId}`);
  expect(listing.status()).toBe(404);

  // The Owner restores the member's item into the Home; once the member leaves the Home they see
  // nothing of its trash at all.
  await page.getByLabel(/Member's item/).check();
  await page.getByTestId("trash-restore").click();
  await expect(page.getByTestId("trash-result")).toContainText("1 item restored.");
  expect(sampleState(byMember)).toBe("active");
  removeMember(homeId, member.email);
  const afterLeaving = await memberPage.request.get(`/api/v1/trash?homeId=${homeId}`);
  expect(afterLeaving.status()).toBe(404);

  await memberContext.close();
  await strangerContext.close();
});
