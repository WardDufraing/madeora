import type { Browser, Page } from "@playwright/test";

import { registerConfirmed, signIn, type Account } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { addMember, createHomeFor, setGlobalProfile, sql } from "../support/database";

// S32: the native calendar. A personal event is its owner's alone unless shared with a Home, where
// members see it read-only and marked "Shared by"; an unshared one shows nothing there, not even
// busy time. Recurring Home events change for this and following events; calendar levels keep
// editing and deleting separate; Home vacations show as banners each person can hide. Each test
// makes its own accounts.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
  viewport: { width: 1280, height: 900 },
});

function isoDaysAhead(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** "17/11/2026", as the en-GB regional formats show a date. */
function shown(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day ?? ""}/${month ?? ""}/${year ?? ""}`;
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

/** Adds an event from the new-event page and returns the event page's address. */
async function addEvent(
  page: Page,
  calendar: string,
  event: {
    readonly title: string;
    readonly startsOn: string;
    readonly share?: string;
    readonly weeklyTimes?: number;
    readonly reminder?: string;
  },
): Promise<string> {
  await page.goto(`${calendar}/new?date=${event.startsOn}`);
  const form = page.getByTestId("event-form");
  await form.getByTestId("event-title").fill(event.title);
  if (event.share) {
    await form.getByTestId("event-shares").getByRole("checkbox", { name: event.share }).check();
  }
  if (event.weeklyTimes) {
    await form.getByTestId("repeat-frequency").selectOption("weekly");
    await form.getByLabel("After a number of times").check();
    await form.getByTestId("repeat-count").fill(String(event.weeklyTimes));
  }
  if (event.reminder) await form.getByTestId("event-reminder").selectOption(event.reminder);
  await form.getByTestId("event-save").click();
  await expect(page).toHaveURL(/\/events\/[0-9a-f-]{36}(\?on=[0-9-]+)?$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(event.title);
  return page.url();
}

test("Calendar: sharing a personal event, privacy of unshared ones, and calendar levels", async ({
  page,
  browser,
  baseURL,
}) => {
  test.slow();
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  const bea = await otherAdult(browser, baseURL, "Bea");
  addMember(homeId, bea.account.email, "member");
  const day = isoDaysAhead(2);

  await addEvent(page, "/calendar", {
    title: "Dentist",
    startsOn: day,
    share: "Thuis",
    reminder: "1 hour before",
  });
  await expect(page.getByTestId("event-reminder-shown")).toHaveText("1 hour before");
  const secret = await addEvent(page, "/calendar", { title: "Surprise party", startsOn: day });
  const secretId = /events\/([0-9a-f-]{36})/.exec(secret)?.[1] ?? "";

  // The Personal calendar shows both to Ward.
  await page.goto(`/calendar?view=agenda&date=${isoDaysAhead(0)}`);
  await expect(page.getByTestId("calendar-agenda")).toContainText("Dentist");
  await expect(page.getByTestId("calendar-agenda")).toContainText("Surprise party");

  // Show tasks lays Ward's own task over his calendar on its due date, only while he chooses so.
  await page.goto("/tasks/manage");
  await page.getByTestId("list-new").fill("House");
  await page.getByRole("button", { name: "Create list" }).click();
  await expect(page.getByTestId("manage-list").filter({ hasText: "House" })).toBeVisible();
  await page.goto("/tasks");
  const opener = page.getByTestId("new-task-open");
  await expect(opener.or(page.getByTestId("new-task-form"))).toBeVisible();
  if (await opener.isVisible()) await opener.click();
  await page.getByLabel("Title").fill("Pay rent");
  await page.getByLabel("Due date").fill(day);
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByTestId("task-row").filter({ hasText: "Pay rent" })).toHaveCount(1);
  await page.goto(`/calendar?view=agenda&date=${isoDaysAhead(0)}`);
  await expect(page.getByTestId("calendar-overlay")).toHaveCount(0);
  await page.getByTestId("calendar-show-tasks").check();
  const overlay = page.getByTestId("calendar-overlay").filter({ hasText: "Pay rent" });
  await expect(overlay).toContainText("Task");
  await page.reload();
  await expect(page.getByTestId("calendar-show-tasks")).toBeChecked();
  await expect(overlay).toHaveCount(1);
  await expect(page.getByTestId("calendar-show-chores")).toHaveCount(0);

  // Bea sees the shared one, read-only, and nothing at all of the other.
  await bea.page.goto(`/homes/${homeId}/calendar?view=agenda&date=${isoDaysAhead(0)}`);
  const agenda = bea.page.getByTestId("calendar-agenda");
  await expect(agenda).toContainText("Dentist");
  await expect(agenda).toContainText("Shared by Ward");
  await expect(agenda).not.toContainText("Surprise party");
  await expect(bea.page.getByTestId("calendar-event")).toHaveCount(1);
  // Her own overlays for this Home show none of Ward's personal tasks.
  await bea.page.getByTestId("calendar-show-tasks").check();
  await bea.page.getByTestId("calendar-show-chores").check();
  await expect(bea.page.getByTestId("calendar-show-chores")).toBeChecked();
  await bea.page.reload();
  await expect(bea.page.getByTestId("calendar-show-tasks")).toBeChecked();
  await expect(agenda).not.toContainText("Pay rent");
  expect(await axeViolations(bea.page)).toEqual([]);
  await agenda.getByRole("link", { name: /Dentist/ }).click();
  await expect(bea.page.getByTestId("event-shared-by")).toContainText("Shared by Ward");
  // Ward's reminder is his own: nothing of it shows to the Home.
  await expect(bea.page.getByTestId("event-reminder-shown")).toHaveCount(0);
  await expect(bea.page.getByTestId("event-edit")).toHaveCount(0);
  await expect(bea.page.getByTestId("event-delete")).toHaveCount(0);
  // A forged address answers like a missing event, in the Home and in her own space.
  await bea.page.goto(`/homes/${homeId}/calendar/events/${secretId}`);
  await expect(bea.page.getByText("Event not found")).toBeVisible();
  await expect(bea.page.getByText("Surprise party")).toHaveCount(0);
  await bea.page.goto(`/calendar/events/${secretId}`);
  await expect(bea.page.getByText("Event not found")).toBeVisible();

  // A Home event: Bea (Edit, the default) may change it but not delete it.
  const homeEvent = await addEvent(page, `/homes/${homeId}/calendar`, {
    title: "Plumber",
    startsOn: day,
  });
  await bea.page.goto(homeEvent);
  await expect(bea.page.getByTestId("event-edit")).toBeVisible();
  await expect(bea.page.getByTestId("event-delete")).toHaveCount(0);

  // Ward gives her Edit and delete on her member page; she can delete now.
  const beaMembership = sql(
    `select m.id from public.home_memberships m join auth.users u on u.id = m.user_id
     where m.home_id = :'home'::uuid and u.email = :'email';`,
    { home: homeId, email: bea.account.email },
  );
  await page.goto(`/homes/${homeId}/members/${beaMembership}`);
  await page.getByTestId("calendar-access-level").selectOption("edit_delete");
  await page.getByTestId("calendar-access-save").click();
  await expect(page.getByText("Calendar access for Bea saved.")).toBeVisible();
  await bea.page.goto(homeEvent);
  await bea.page.getByTestId("event-delete").click();
  const dialog = bea.page.getByRole("dialog", { name: "Delete event?" });
  await dialog.getByTestId("event-delete-confirm").click();
  await expect(bea.page).toHaveURL(new RegExp(`/homes/${homeId}/calendar$`));

  // Ward stops sharing: the event is gone from the Home on Bea's next request.
  await page.goto(`/calendar?view=agenda&date=${isoDaysAhead(0)}`);
  await page
    .getByTestId("calendar-agenda")
    .getByRole("link", { name: /Dentist/ })
    .click();
  await page.getByTestId("event-share-home").uncheck();
  await page.getByTestId("event-share-save").click();
  await expect(page.getByText("Sharing saved.")).toBeVisible();
  await bea.page.goto(`/homes/${homeId}/calendar?view=agenda&date=${isoDaysAhead(0)}`);
  await expect(bea.page.getByTestId("calendar-agenda")).not.toContainText("Dentist");
  await bea.close();
});

test("Calendar: a weekly Home event changed for this and following events, and vacation banners", async ({
  page,
  baseURL,
}) => {
  test.slow();
  const ward = await newAdult(page, baseURL, "Ward");
  const homeId = createHomeFor(ward.email, "Thuis");
  const start = isoDaysAhead(1);
  const second = isoDaysAhead(8);
  const third = isoDaysAhead(15);

  const series = await addEvent(page, `/homes/${homeId}/calendar`, {
    title: "Choir",
    startsOn: start,
    weeklyTimes: 4,
  });
  const eventId = /events\/([0-9a-f-]{36})/.exec(series)?.[1] ?? "";

  // Edit the second occurrence: this and following.
  await page.goto(`/homes/${homeId}/calendar/events/${eventId}/edit?on=${second}`);
  const form = page.getByTestId("event-form");
  await form.getByTestId("event-scope-following").check();
  await form.getByTestId("event-title").fill("Choir rehearsal");
  await form.getByTestId("event-save").click();
  const preview = page.getByTestId("event-preview");
  await expect(preview).toContainText(shown(second));
  await expect(preview).toContainText(shown(third));
  expect(await axeViolations(page)).toEqual([]);
  await page.getByTestId("event-confirm").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Choir rehearsal");

  await page.goto(`/homes/${homeId}/calendar?view=agenda&date=${start}`);
  const days = page.getByTestId("calendar-list-day");
  await expect(days.filter({ hasText: shown(start) })).toContainText("Choir");
  await expect(days.filter({ hasText: shown(start) })).not.toContainText("Choir rehearsal");
  await expect(days.filter({ hasText: shown(second) })).toContainText("Choir rehearsal");
  await expect(days.filter({ hasText: shown(third) })).toContainText("Choir rehearsal");
  await expect(page.getByTestId("calendar-event")).toHaveCount(4);

  // A confirmed Home vacation shows as a banner over its dates; hiding it is Ward's own choice.
  const [userId, membershipId] = sql(
    `select u.id || ' ' || m.id from auth.users u join public.home_memberships m on m.user_id = u.id
     where u.email = :'email' and m.home_id = :'home'::uuid;`,
    { email: ward.email, home: homeId },
  ).split(" ");
  sql(
    `select set_config('request.jwt.claims', json_build_object('sub', :'user', 'role', 'authenticated')::text, true);
     set local role authenticated;
     select public.create_home_vacation(gen_random_uuid(), :'home'::uuid, 'Ski trip',
       jsonb_build_array(jsonb_build_object('memberId', :'member', 'startsOn', :'from', 'endsOn', :'to')));`,
    { user: userId ?? "", member: membershipId ?? "", home: homeId, from: second, to: third },
  );
  await page.goto(`/homes/${homeId}/calendar?view=month&date=${second}`);
  await expect(page.getByTestId("calendar-banner-row").first()).toContainText("Ski trip");
  const toggle = page.getByTestId("calendar-show-vacations");
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(page.getByTestId("calendar-banner-row")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("calendar-show-vacations")).not.toBeChecked();
  await expect(page.getByTestId("calendar-banner-row")).toHaveCount(0);
});
