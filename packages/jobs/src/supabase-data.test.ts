import { describe, expect, it } from "vitest";

import { createSupabaseJobData } from "./supabase-data.ts";
import { JobStoreError, type JobsSupabaseClient } from "./supabase-store.ts";

type RpcResult = { data: unknown; error: { code: string; message: string } | null };

function fakeClient(results: Record<string, RpcResult>) {
  const calls: { fn: string; args: unknown }[] = [];
  const client = {
    rpc: (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return Promise.resolve(
        results[fn] ?? { data: null, error: { code: "PGRST202", message: "" } },
      );
    },
  } as unknown as JobsSupabaseClient;
  return { client, calls };
}

const ok = (data: unknown): RpcResult => ({ data, error: null });

describe("Supabase job data", () => {
  it("maps a notification email and sends only the id", async () => {
    const { client, calls } = fakeClient({
      get_notification_email: ok([
        {
          outcome: "ok",
          recipient_email: "carol@example.test",
          locale: "nl",
          kind: "recovery.claimant_ready",
          category: "security",
          home_id: "h1",
          home_name: "Thuis",
          home_time_zone: "Europe/Brussels",
          params: { recoveryId: "r1" },
        },
      ]),
    });
    const read = await createSupabaseJobData(client).getNotificationEmail("n1");
    expect(read).toEqual({
      outcome: "ok",
      to: "carol@example.test",
      locale: "nl",
      kind: "recovery.claimant_ready",
      homeId: "h1",
      homeName: "Thuis",
      homeTimeZone: "Europe/Brussels",
      params: { recoveryId: "r1" },
    });
    expect(calls).toEqual([{ fn: "get_notification_email", args: { p_notification_id: "n1" } }]);
  });

  it("falls back to English for an unknown language", async () => {
    const { client } = fakeClient({
      get_notification_email: ok([
        { outcome: "ok", recipient_email: "a@b.test", locale: "de", kind: "k.k", params: null },
      ]),
    });
    const read = await createSupabaseJobData(client).getNotificationEmail("n1");
    expect(read).toMatchObject({ outcome: "ok", locale: "en", params: {} });
  });

  it.each(["not_found", "already_done", "not_member", "disabled", "no_address", "cannot_receive"])(
    "passes the %s outcome on",
    async (outcome) => {
      const { client } = fakeClient({ get_notification_email: ok([{ outcome }]) });
      await expect(createSupabaseJobData(client).getNotificationEmail("n1")).resolves.toEqual({
        outcome,
      });
    },
  );

  it("fails on an answer it does not know, rather than guessing", async () => {
    const { client } = fakeClient({ get_notification_email: ok([{ outcome: "maybe" }]) });
    await expect(createSupabaseJobData(client).getNotificationEmail("n1")).rejects.toMatchObject({
      code: "unexpected_result",
    });
    const { client: empty } = fakeClient({ get_notification_email: ok([]) });
    await expect(createSupabaseJobData(empty).getNotificationEmail("n1")).rejects.toBeInstanceOf(
      JobStoreError,
    );
  });

  it("records an email outcome with a code only when there is one", async () => {
    const { client, calls } = fakeClient({ record_notification_email: ok(true) });
    const data = createSupabaseJobData(client);
    await data.recordNotificationEmail("n1", "sent", null);
    await data.recordNotificationEmail("n1", "failed", "email_unavailable");
    expect(calls.map((call) => call.args)).toEqual([
      { p_notification_id: "n1", p_status: "sent" },
      { p_notification_id: "n1", p_status: "failed", p_error_code: "email_unavailable" },
    ]);
  });

  it("maps an invitation email", async () => {
    const { client, calls } = fakeClient({
      get_invitation_email: ok([
        {
          outcome: "ok",
          recipient_email: "zed@example.test",
          email_locale: "nl",
          role: "administrator",
          token: "tok",
          expires_at: "2026-10-22T10:00:00+00:00",
          home_name: "Thuis",
          home_time_zone: "Europe/Brussels",
        },
      ]),
    });
    const read = await createSupabaseJobData(client).getInvitationEmail("i1", 2);
    expect(read).toEqual({
      outcome: "ok",
      to: "zed@example.test",
      locale: "nl",
      role: "administrator",
      token: "tok",
      expiresAt: new Date("2026-10-22T10:00:00Z"),
      homeName: "Thuis",
      homeTimeZone: "Europe/Brussels",
    });
    expect(calls[0]).toEqual({
      fn: "get_invitation_email",
      args: { p_invitation_id: "i1", p_send: 2 },
    });
  });

  it("refuses an incomplete invitation row", async () => {
    const { client } = fakeClient({
      get_invitation_email: ok([{ outcome: "ok", recipient_email: "zed@example.test" }]),
    });
    await expect(createSupabaseJobData(client).getInvitationEmail("i1", 1)).rejects.toMatchObject({
      code: "unexpected_result",
    });
  });

  it("passes skip outcomes and the recovery-ready call through", async () => {
    const { client, calls } = fakeClient({
      get_invitation_email: ok([{ outcome: "superseded" }]),
      record_invitation_email: ok(false),
      deliver_recovery_ready: ok("notified"),
    });
    const data = createSupabaseJobData(client);
    await expect(data.getInvitationEmail("i1", 1)).resolves.toEqual({ outcome: "superseded" });
    await expect(data.recordInvitationEmail("i1", 1, "sent")).resolves.toBe(false);
    await expect(data.deliverRecoveryReady("r1", new Date("2026-10-29T16:00:00Z"))).resolves.toBe(
      "notified",
    );
    expect(calls[2]?.args).toEqual({
      p_recovery_id: "r1",
      p_objection_ends_at: "2026-10-29T16:00:00.000Z",
    });
  });

  it("delivers a reminder by id and revision and refuses an unknown answer", async () => {
    const { client, calls } = fakeClient({
      deliver_task_reminder: ok("stale"),
      advance_reminder_series: ok(3),
    });
    const data = createSupabaseJobData(client);
    await expect(data.deliverTaskReminder("t1", 2)).resolves.toBe("stale");
    await expect(data.advanceReminderSeries(200)).resolves.toBe(3);
    expect(calls).toEqual([
      { fn: "deliver_task_reminder", args: { p_task_id: "t1", p_revision: 2 } },
      { fn: "advance_reminder_series", args: { p_limit: 200 } },
    ]);
    const { client: odd } = fakeClient({ deliver_task_reminder: ok("sent twice") });
    await expect(createSupabaseJobData(odd).deliverTaskReminder("t1", 2)).rejects.toMatchObject({
      code: "unexpected_result",
    });
  });

  it("delivers habit reminders, snoozes and pause ends and refuses an unknown answer", async () => {
    const { client, calls } = fakeClient({
      deliver_habit_reminder: ok("late"),
      advance_habit_reminders: ok(4),
      deliver_habit_snooze: ok("cancelled"),
      deliver_habit_pause_end: ok("still_paused"),
    });
    const data = createSupabaseJobData(client);
    await expect(data.deliverHabitReminder("h1", 2, "2026-11-10T07:30:00Z")).resolves.toBe("late");
    await expect(data.advanceHabitReminders(200)).resolves.toBe(4);
    await expect(data.deliverHabitSnooze("n1")).resolves.toBe("cancelled");
    await expect(data.deliverHabitPauseEnd("p1", "2026-11-12")).resolves.toBe("still_paused");
    expect(calls).toEqual([
      {
        fn: "deliver_habit_reminder",
        args: { p_habit_id: "h1", p_revision: 2, p_at: "2026-11-10T07:30:00Z" },
      },
      { fn: "advance_habit_reminders", args: { p_limit: 200 } },
      { fn: "deliver_habit_snooze", args: { p_notification_id: "n1" } },
      { fn: "deliver_habit_pause_end", args: { p_pause_id: "p1", p_resumes_on: "2026-11-12" } },
    ]);
    const { client: odd } = fakeClient({
      deliver_habit_reminder: ok("not_sent"),
      deliver_habit_snooze: ok("notified twice"),
      deliver_habit_pause_end: ok("resumed"),
    });
    const strict = createSupabaseJobData(odd);
    for (const call of [
      strict.deliverHabitReminder("h1", 1, "2026-11-10T07:30:00Z"),
      strict.deliverHabitSnooze("n1"),
      strict.deliverHabitPauseEnd("p1", "2026-11-12"),
    ]) {
      await expect(call).rejects.toMatchObject({ code: "unexpected_result" });
    }
  });

  it("rolls recurring goal series with the batch limit", async () => {
    const { client, calls } = fakeClient({ roll_goal_periods: ok(2) });
    await expect(createSupabaseJobData(client).rollGoalPeriods(200)).resolves.toBe(2);
    expect(calls).toEqual([{ fn: "roll_goal_periods", args: { p_limit: 200 } }]);
  });

  it("delivers goal reminders and refuses an unknown answer", async () => {
    const { client, calls } = fakeClient({ deliver_goal_reminder: ok("inactive") });
    await expect(
      createSupabaseJobData(client).deliverGoalReminder("g1", 3, "overdue", "2026-11-10T08:00:00Z"),
    ).resolves.toBe("inactive");
    expect(calls).toEqual([
      {
        fn: "deliver_goal_reminder",
        args: { p_goal_id: "g1", p_revision: 3, p_kind: "overdue", p_at: "2026-11-10T08:00:00Z" },
      },
    ]);
    const { client: odd } = fakeClient({ deliver_goal_reminder: ok("not_needed") });
    await expect(
      createSupabaseJobData(odd).deliverGoalReminder("g1", 1, "lead", "2026-11-10T08:00:00Z"),
    ).rejects.toMatchObject({ code: "unexpected_result" });
  });

  it("throws the Postgres code only", async () => {
    const { client } = fakeClient({
      get_notification_email: {
        data: null,
        error: { code: "42501", message: "carol@example.test" },
      },
    });
    const failure = createSupabaseJobData(client).getNotificationEmail("n1");
    await expect(failure).rejects.toMatchObject({ code: "42501" });
    await expect(failure).rejects.not.toThrow("carol@example.test");
  });
});
