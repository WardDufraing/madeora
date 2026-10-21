import { notificationKinds } from "@madeora/email";
import { describe, expect, it } from "vitest";

import { buildNotificationEmail } from "./notification-email-content.ts";

const homeId = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const base = {
  locale: "en",
  homeId,
  homeName: "De Boomgaard",
  homeTimeZone: "Europe/Brussels",
  appUrl: "https://app.madeora.test",
} as const;

describe("buildNotificationEmail", () => {
  it.each(notificationKinds.filter((kind) => !kind.startsWith("join_request.decided.")))(
    "renders %s",
    async (kind) => {
      const email = await buildNotificationEmail({
        ...base,
        kind,
        params: { objectionEndsAt: "2026-10-29T16:00:00Z" },
      });
      expect(email.subject.length).toBeGreaterThan(0);
      expect(email.text).toContain("https://app.madeora.test/");
    },
  );

  it.each(["approved", "declined"] as const)(
    "renders a %s join request decision",
    async (decision) => {
      const email = await buildNotificationEmail({
        ...base,
        homeId: null,
        homeName: null,
        homeTimeZone: null,
        kind: "join_request.decided",
        params: { decision },
      });
      expect(email.subject).toContain(decision === "approved" ? "approved" : "declined");
    },
  );

  it("emails a reminder with the Home and due day but never the task, linking to the task", async () => {
    const taskId = "5d2a7c41-8b3e-4f9a-a1c2-3e4f5a6b7c8d";
    const email = await buildNotificationEmail({
      ...base,
      kind: "task.reminder",
      params: { taskId, dueDate: "2027-03-28" },
    });
    expect(email.subject).toBe(
      "Reminder: a task in \u2068De Boomgaard\u2069 is due March 28, 2027",
    );
    expect(email.text).toContain(`https://app.madeora.test/homes/${homeId}/tasks/${taskId}`);
    const personal = await buildNotificationEmail({
      ...base,
      locale: "nl",
      homeId: null,
      homeName: null,
      homeTimeZone: null,
      kind: "task.reminder",
      params: { taskId, dueDate: null },
    });
    expect(personal.subject).toBe("Herinnering: een taak in je persoonlijke ruimte");
    expect(personal.text).toContain(`https://app.madeora.test/tasks/${taskId}`);
  });

  it("emails reviewers that chores wait, naming neither the chore nor a person", async () => {
    const email = await buildNotificationEmail({
      ...base,
      kind: "chore.approval_requested",
      params: { homeId },
    });
    expect(email.subject).toBe("Chores in \u2068De Boomgaard\u2069 are waiting for your review");
    expect(email.text).toContain(`https://app.madeora.test/homes/${homeId}/chores/approvals`);
    const nl = await buildNotificationEmail({
      ...base,
      locale: "nl",
      kind: "chore.approval_requested",
      params: { homeId },
    });
    expect(nl.subject).toBe("Klusjes in \u2068De Boomgaard\u2069 wachten op je beoordeling");
  });

  it("keeps the owner's two recovery emails on their own template", async () => {
    const review = await buildNotificationEmail({
      ...base,
      kind: "recovery.owner_review_started",
      params: {},
    });
    expect(review.text).toContain("I still have access");
    const approved = await buildNotificationEmail({
      ...base,
      kind: "recovery.owner_approved",
      params: { objectionEndsAt: "2026-10-29T16:00:00Z" },
    });
    expect(approved.text).toContain("17:00");
  });

  it("refuses the owner's approval email without the end date", async () => {
    await expect(
      buildNotificationEmail({ ...base, kind: "recovery.owner_approved", params: {} }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it.each(["recovery.member_requested", "recovery.owner_requested", "nonsense.kind"])(
    "has no template for %s",
    async (kind) => {
      await expect(buildNotificationEmail({ ...base, kind, params: {} })).rejects.toMatchObject({
        code: "no_email_template",
      });
    },
  );

  it("refuses params it does not understand", async () => {
    await expect(
      buildNotificationEmail({
        ...base,
        kind: "recovery.claimant_paused",
        params: { objectionEndsAt: "soon" },
      }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });
});

describe("a notice without a Home", () => {
  it.each([
    ["en", "a Home"],
    ["nl", "een Home"],
  ] as const)("names it generically in %s", async (locale, words) => {
    const email = await buildNotificationEmail({
      ...base,
      locale,
      homeId: null,
      homeName: null,
      homeTimeZone: null,
      kind: "recovery.claimant_invalid",
      params: {},
    });
    expect(email.subject).toContain(words);
  });
});
