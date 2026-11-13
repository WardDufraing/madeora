import { registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { setGlobalProfile, sql } from "../support/database";

// S44, the spec's "Shared screen" journey: pair a tablet, show only the Home's own shareable
// information on it, and keep everything private off it. A member completes a chore on the
// display (attributed to them, with their PIN), a manager changes this display's layout from their
// own session, locks it on the display with their PIN, and only unlocks it from their own session.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 800 },
  allowedConsoleErrors: [/status of 40[19]/],
});

const PIN = "4826";

test("a paired display shows only shareable Home data, takes actions and locks", async ({
  page,
  baseURL,
  browser,
}) => {
  const base = baseURL ?? "";
  const account = await registerConfirmed(base);
  setGlobalProfile(account.email, "Ward", "#2563eb");
  await signIn(page, account);
  await page.goto("/homes/new");
  await page.getByRole("textbox", { name: /Home name/ }).fill("Thuis");
  await page.getByRole("button", { name: "Create Home" }).click();
  await page.waitForURL(/\/homes\/[0-9a-f-]{36}$/);
  const homeId = page.url().split("/").pop() ?? "";

  // Ward's household-device PIN, a chore due today, a Home list (an item with a private note)
  // and Ward's personal list.
  const pinSet = await page.request.post(`${base}/api/v1/me/device-pin`, {
    headers: { "content-type": "application/json", origin: base },
    data: { pin: PIN },
  });
  expect(pinSet.status()).toBe(200);
  const userId = sql(`select id from auth.users where email = :'email';`, {
    email: account.email,
  });
  sql(
    `select set_config('request.jwt.claims', json_build_object('sub', :'user', 'role', 'authenticated')::text, true);
     set local role authenticated;
     select occurrence_id from public.create_chore(gen_random_uuid(), :'home'::uuid, 'Bins',
       '{"mode": "none", "members": []}',
       p_due_date => (select (now() at time zone h.timezone)::date from public.homes h where h.id = :'home'::uuid));
     select public.create_shopping_list('11111111-1111-4111-8111-111111111111', 'Groceries', :'home'::uuid);
     select public.create_shopping_list('22222222-2222-4222-8222-222222222222', 'My secret list');
     select count(*) from public.add_shopping_items('11111111-1111-4111-8111-111111111111', jsonb_build_array(
       jsonb_build_object('id', gen_random_uuid(), 'name', 'Milk', 'quantity', '2', 'unit', null,
         'packaging', null, 'notes', 'private note for Ward', 'categoryId', null, 'allowDuplicate', false)));
     select count(*) from public.add_shopping_items('22222222-2222-4222-8222-222222222222', jsonb_build_array(
       jsonb_build_object('id', gen_random_uuid(), 'name', 'Birthday gift', 'quantity', null, 'unit', null,
         'packaging', null, 'notes', null, 'categoryId', null, 'allowDuplicate', false)));`,
    { user: userId, home: homeId },
  );

  // Pair a fresh tablet (S43).
  const tablet = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const screen = await tablet.newPage();
  await screen.goto(`${base}/display`);
  const codeText = (await screen.getByTestId("pairing-code").textContent()) ?? "";
  await page.goto(`/homes/${homeId}/displays`);
  await page.getByRole("textbox", { name: /Pairing code/ }).fill(codeText);
  await page.getByRole("button", { name: "Check code" }).click();
  await page.getByRole("textbox", { name: /Display name/ }).fill("Kitchen");
  await page.getByRole("button", { name: "Approve display" }).click();
  await expect(page.getByText(/Kitchen is paired/)).toBeVisible();

  // The default layout: clock, the Home's chores and the Home's list; nothing private.
  await expect(screen.getByTestId("display-board")).toBeVisible({ timeout: 15_000 });
  await expect(screen.getByTestId("display-widget-clock")).toBeVisible();
  await expect(screen.getByTestId("display-widget-chores")).toContainText("Bins");
  await expect(screen.getByTestId("display-widget-shopping")).toContainText("Groceries");
  await expect(screen.getByTestId("display-widget-shopping")).toContainText("Milk");
  await expect(screen.getByText("private note for Ward")).toHaveCount(0);
  await expect(screen.getByText("My secret list")).toHaveCount(0);
  await expect(screen.getByText("Birthday gift")).toHaveCount(0);
  expect(await axeViolations(screen)).toEqual([]);

  // Ward completes the chore on the display, confirmed with their PIN.
  await screen.getByRole("button", { name: /Bins/ }).click();
  await screen.getByRole("button", { name: "Ward" }).click();
  await screen.getByRole("checkbox", { name: "Confirm with my PIN" }).check();
  await screen.getByRole("textbox", { name: "PIN for Ward" }).fill(PIN);
  await screen.getByRole("button", { name: "Confirm" }).click();
  await expect(screen.getByText("Bins is done.")).toBeVisible();
  expect(
    sql(
      `select count(*) from private.audit_events e
       where e.home_id = :'home'::uuid and e.action = 'chore_occurrence.display_completed'
         and e.details ->> 'verification' = 'pin';`,
      { home: homeId },
    ),
  ).toBe("1");

  // Ward changes this display's layout from their own session: no shopping list here.
  await page.goto(`/homes/${homeId}/displays`);
  await page.getByRole("link", { name: "Layout and privacy lock of Kitchen" }).click();
  await page.waitForURL(/\/displays\/[0-9a-f-]{36}$/);
  expect(await axeViolations(page)).toEqual([]);
  // Drag the shopping list to the top of the preview: it becomes the first widget.
  const preview = page.getByTestId("display-config-preview");
  const shoppingTile = preview.locator('[data-widget-type="shopping"]');
  const clockTile = preview.locator('[data-widget-type="clock"]');
  await preview.scrollIntoViewIfNeeded();
  const from = await shoppingTile.boundingBox();
  const to = await clockTile.boundingBox();
  if (!from || !to) throw new Error("preview tiles not laid out");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 10, to.y + 10, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByText("1. Shopping")).toBeVisible();
  await page.getByRole("button", { name: "Remove Shopping (position 1)" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/Layout saved/)).toBeVisible();
  await screen.reload();
  await expect(screen.getByTestId("display-board")).toBeVisible();
  await expect(screen.getByTestId("display-widget-shopping")).toHaveCount(0);
  await expect(screen.getByTestId("display-widget-chores")).toBeVisible();

  // Ward locks the display on the display itself, with their PIN.
  await screen.getByRole("button", { name: "Privacy lock" }).click();
  await screen.getByRole("button", { name: "Ward" }).click();
  await screen.getByRole("textbox", { name: "PIN of Ward" }).fill(PIN);
  await screen.getByRole("button", { name: "Turn on privacy mode" }).click();
  await expect(screen.getByTestId("display-locked")).toBeVisible();
  await expect(screen.getByText("Thuis")).toHaveCount(0);
  await expect(screen.getByText("Bins")).toHaveCount(0);
  await expect(screen.getByText("Kitchen", { exact: false })).toHaveCount(0);
  expect(await axeViolations(screen)).toEqual([]);

  // It stays locked through a restart; nothing on the display unlocks it.
  await screen.close();
  const restarted = await tablet.newPage();
  await restarted.goto(`${base}/display`);
  await expect(restarted.getByTestId("display-locked")).toBeVisible();
  await expect(restarted.getByRole("button", { name: /Turn off/ })).toHaveCount(0);

  // Only Ward's own session turns it off.
  await page.reload();
  await expect(page.getByText("Privacy mode is on.")).toBeVisible();
  await page.getByRole("button", { name: "Turn off privacy mode" }).click();
  await expect(page.getByText(/Privacy mode is off\. The display/)).toBeVisible();
  await restarted.reload();
  await expect(restarted.getByTestId("display-board")).toBeVisible();
  await expect(restarted.getByTestId("display-widget-chores")).toBeVisible();
  await tablet.close();

  // No PIN in clear anywhere in the audit trail.
  expect(
    sql(
      `select count(*) from private.audit_events e
       where e.home_id = :'home'::uuid and to_jsonb(e)::text like '%' || :'pin' || '%';`,
      { home: homeId, pin: PIN },
    ),
  ).toBe("0");
});
