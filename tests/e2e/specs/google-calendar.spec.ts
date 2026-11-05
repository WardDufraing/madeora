import { registerConfirmed, signIn } from "../support/accounts";
import { axeViolations, expect, test } from "../support/browser";
import { sql } from "../support/database";

// S33: Google Calendar settings. CI has no Google Calendar client configured, so the page must say the
// connection is not available (never offer a connect button that cannot work) and stay accessible. The
// OAuth flow, sync and privacy rules are covered by unit, route and database tests.
test.use({
  storageState: { cookies: [], origins: [] },
  locale: "en-GB",
  timezoneId: "Europe/London",
});

test("settings lead to Google Calendar, which says it is not available here", async ({
  page,
  baseURL,
}) => {
  const account = await registerConfirmed(baseURL ?? "");
  await signIn(page, account);
  await page.goto("/settings");
  await page.getByTestId("google-calendar-link").click();
  await expect(page).toHaveURL(/\/settings\/google-calendar$/);
  await expect(page.getByRole("heading", { level: 1, name: "Google Calendar" })).toBeVisible();
  await expect(page.getByTestId("google-not-available")).toBeVisible();
  await expect(page.getByTestId("google-connect")).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
});

// S34: the "Google Calendar" journey for a connected person, with Google itself replaced by rows a sync
// would have stored (CI has no Google client). Changes from Madeora wait for the sync job; a conflict shows
// both versions and never resolves itself; "Remove from Madeora" works on a read-only calendar and leaves
// Google alone. Pushing to Google, DST and series splits are covered by package and database tests.
function seedGoogle(email: string): { dentist: string; lunch: string; holiday: string } {
  const ids = sql(
    `
    with person as (select id from auth.users where email = :'email'),
    connection as (
      insert into private.google_calendar_connections (user_id, account, refresh_token, scopes,
          calendars_listed_at, last_attempt_at, last_synced_at)
      select id, :'email', 'v1.' || repeat('a', 16) || '.' || repeat('c', 40) || '.' || repeat('t', 22),
        array['https://www.googleapis.com/auth/calendar.events'], now(), now(), now()
      from person
      returning id, user_id
    ),
    work as (
      insert into private.google_calendars (connection_id, user_id, google_calendar_id, name, time_zone,
          access_role, is_primary, sync_enabled, show_personal, last_synced_at, full_synced_at)
      select id, user_id, :'email', 'Work', 'Europe/London', 'owner', true, true, true, now(), now()
      from connection
      returning id
    ),
    holidays as (
      insert into private.google_calendars (connection_id, user_id, google_calendar_id, name, access_role,
          sync_enabled, show_personal, last_synced_at, full_synced_at)
      select id, user_id, 'holidays', 'UK holidays', 'reader', true, true, now(), now()
      from connection
      returning id
    ),
    events as (
      insert into private.google_calendar_events (calendar_id, google_event_id, etag, status, title, all_day,
          starts_at, ends_at, time_zone)
      select work.id, 'dentist', '"d1"', 'confirmed', 'Dentist', false,
        date '2026-12-03' + time '09:00', date '2026-12-03' + time '10:00', 'Europe/London' from work
      union all
      select work.id, 'lunch', '"l2"', 'confirmed', 'Team lunch at 1', false,
        date '2026-12-04' + time '12:00', date '2026-12-04' + time '13:00', 'Europe/London' from work
      returning id, google_event_id
    ),
    holiday as (
      insert into private.google_calendar_events (calendar_id, google_event_id, etag, status, title, all_day,
          starts_on, ends_on)
      select holidays.id, 'boxing', '"h1"', 'confirmed', 'Boxing Day', true, date '2026-12-26', date '2026-12-26'
      from holidays
      returning id
    )
    select (select id from events where google_event_id = 'dentist') || ' ' ||
      (select id from events where google_event_id = 'lunch') || ' ' || (select id from holiday);
    -- Both sides changed the title: Madeora's edit waits as a conflict with Google's newer version.
    insert into private.google_calendar_changes (calendar_id, user_id, action, scope, google_event_id, fields,
        base, mine, theirs, state, conflict_fields, title)
    select e.calendar_id, c.user_id, 'update', 'event', 'lunch', array['title'],
      private.google_snapshot(e) || jsonb_build_object('title', 'Team lunch', 'etag', '"l1"'),
      private.google_snapshot(e) || jsonb_build_object('title', 'Team lunch (Room 2)'),
      private.google_snapshot(e), 'conflict', array['title'], 'Team lunch (Room 2)'
    from private.google_calendar_events e
    join private.google_calendars c on c.id = e.calendar_id
    join auth.users u on u.id = c.user_id
    where e.google_event_id = 'lunch' and u.email = :'email';
    `,
    { email },
  );
  const [dentist = "", lunch = "", holiday = ""] = ids.split(" ");
  return { dentist, lunch, holiday };
}

function openChanges(email: string): string {
  return sql(
    `select coalesce(string_agg(c.action || ':' || c.state || ':' || coalesce(c.title, ''), ',' order by c.title), '')
     from private.google_calendar_changes c join auth.users u on u.id = c.user_id where u.email = :'email';`,
    { email },
  );
}

test("Google Calendar: edit from Madeora, a conflict waits for a choice, and remove from Madeora", async ({
  page,
  baseURL,
}) => {
  const account = await registerConfirmed(baseURL ?? "");
  await signIn(page, account);
  const { dentist, lunch, holiday } = seedGoogle(account.email);

  // An edit shows at once and waits for the sync to reach Google.
  await page.goto(`/calendar/google/${dentist}`);
  await page.getByTestId("google-event-edit").click();
  await expect(page).toHaveURL(new RegExp(`/calendar/google/${dentist}/edit$`));
  await page.getByTestId("event-title").fill("Dentist (moved)");
  await page.getByTestId("google-event-save").click();
  await expect(page).toHaveURL(new RegExp(`/calendar/google/${dentist}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Dentist (moved)" })).toBeVisible();
  await expect(page.getByTestId("google-change")).toHaveAttribute("data-state", "pending");
  expect(openChanges(account.email)).toContain("update:pending:Dentist (moved)");

  // A conflict shows both versions; looking at it changes nothing, only the person's choice ends it.
  await page.goto(`/calendar/google/${lunch}`);
  const panel = page.getByTestId("google-change");
  await expect(panel).toHaveAttribute("data-state", "conflict");
  await expect(panel.getByTestId("conflict-madeora-title")).toHaveText("Team lunch (Room 2)");
  await expect(panel.getByTestId("conflict-google-title")).toHaveText("Team lunch at 1");
  await expect(page.getByTestId("google-event-edit")).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
  await page.reload();
  expect(openChanges(account.email)).toContain("update:conflict:Team lunch (Room 2)");
  await page.getByTestId("google-keep-google").click();
  await expect(page.getByTestId("google-change")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Team lunch at 1" })).toBeVisible();
  expect(openChanges(account.email)).not.toContain("conflict");

  // A read-only calendar: no Edit, no "Delete everywhere", but it can leave Madeora.
  await page.goto(`/calendar/google/${holiday}`);
  await expect(page.getByTestId("google-event-edit")).toHaveCount(0);
  await page.getByTestId("google-event-delete").click();
  await expect(page.getByTestId("google-delete-everywhere")).toBeDisabled();
  await page.getByTestId("google-delete-madeora").check();
  await page.getByTestId("google-delete-confirm").click();
  await expect(page).toHaveURL(/\/calendar$/);
  await page.goto(`/calendar/google/${holiday}`);
  await expect(page.getByText("Event not found")).toBeVisible();
  expect(openChanges(account.email)).not.toContain("delete");
});
