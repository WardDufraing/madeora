import { describe, expect, it } from "vitest";

import {
  canOnParticipant,
  canOnVacation,
  participantStatus,
  validStay,
  vacationStatus,
  type ParticipantAction,
  type VacationAction,
} from "./vacations";

describe("vacationStatus", () => {
  const trip = { startsOn: "2026-12-20", endsOn: "2026-12-27", cancelled: false };

  it("is upcoming before the first day, active from the first to the last day, then ended", () => {
    expect(vacationStatus(trip, "2026-12-19")).toBe("upcoming");
    expect(vacationStatus(trip, "2026-12-20")).toBe("active");
    expect(vacationStatus(trip, "2026-12-27")).toBe("active");
    expect(vacationStatus(trip, "2026-12-28")).toBe("ended");
  });

  it("stays cancelled whatever the date", () => {
    expect(vacationStatus({ ...trip, cancelled: true }, "2026-12-21")).toBe("cancelled");
    expect(vacationStatus({ ...trip, cancelled: true }, "2027-01-05")).toBe("cancelled");
  });
});

describe("participantStatus", () => {
  it("reads a pending invitation as expired from its start day", () => {
    expect(participantStatus("pending", "2026-12-20", "2026-12-19")).toBe("pending");
    expect(participantStatus("pending", "2026-12-20", "2026-12-20")).toBe("expired");
  });

  it("leaves answered participations as they are", () => {
    for (const status of ["accepted", "declined", "withdrawn", "expired"] as const) {
      expect(participantStatus(status, "2026-12-20", "2026-12-25")).toBe(status);
    }
  });
});

describe("validStay", () => {
  const today = "2026-11-10";

  it("accepts a stay from today on, up to two years ahead", () => {
    expect(validStay("2026-11-10", "2026-11-10", today)).toBe(true);
    expect(validStay("2028-11-09", "2028-11-12", today)).toBe(true);
    expect(validStay("2028-11-10", "2028-11-12", today)).toBe(false);
  });

  it("refuses a start in the past, an end before the start and a stay over 366 days", () => {
    expect(validStay("2026-11-09", "2026-11-12", today)).toBe(false);
    expect(validStay("2026-11-12", "2026-11-11", today)).toBe(false);
    expect(validStay("2026-11-10", "2027-11-10", today)).toBe(true);
    expect(validStay("2026-11-10", "2027-11-11", today)).toBe(false);
  });

  it("keeps a started stay's own start and lets it end yesterday (ending early)", () => {
    expect(validStay("2026-11-01", "2026-11-09", today, "2026-11-01")).toBe(true);
    expect(validStay("2026-11-01", "2026-11-08", today, "2026-11-01")).toBe(false);
    expect(validStay("2026-10-31", "2026-11-12", today, "2026-11-01")).toBe(false);
  });
});

describe("canOnVacation", () => {
  const manager = { manager: true, creator: false };
  const creator = { manager: false, creator: true };
  const member = { manager: false, creator: false };
  const actions: VacationAction[] = [
    "rename",
    "reminder",
    "shorten",
    "cancel",
    "pause",
    "invite",
    "addDirectly",
    "decide",
  ];
  const allowed = (viewer: typeof member, othersAccepted = false) =>
    actions.filter((action) => canOnVacation(action, "upcoming", viewer, othersAccepted));

  it("gives a chore manager every action on an upcoming vacation", () => {
    expect(allowed(manager)).toEqual(actions);
  });

  it("lets a creator rename, invite and cancel while nobody else is in it", () => {
    expect(allowed(creator)).toEqual(["rename", "cancel", "invite"]);
    expect(allowed(creator, true)).toEqual(["rename", "invite"]);
  });

  it("gives any other member nothing", () => {
    expect(allowed(member)).toEqual([]);
  });

  it("keeps the reminder for upcoming vacations and closes changes once ended or cancelled", () => {
    expect(canOnVacation("reminder", "active", manager)).toBe(false);
    expect(canOnVacation("shorten", "active", manager)).toBe(true);
    expect(canOnVacation("shorten", "ended", manager)).toBe(false);
    expect(canOnVacation("rename", "ended", manager)).toBe(true);
    expect(canOnVacation("rename", "cancelled", manager)).toBe(false);
    expect(canOnVacation("decide", "ended", manager)).toBe(true);
    expect(canOnVacation("decide", "cancelled", manager)).toBe(false);
  });
});

describe("canOnParticipant", () => {
  const actions: ParticipantAction[] = [
    "answer",
    "withdraw",
    "remove",
    "cancelInvitation",
    "changeDates",
    "proposeDates",
  ];
  const allowed = (
    participant: { status: "pending" | "accepted"; self: boolean; direct: boolean },
    viewer: { manager: boolean; creator: boolean },
  ) => actions.filter((action) => canOnParticipant(action, "upcoming", participant, viewer));

  it("lets an invitee answer their own invitation, and nobody else", () => {
    const own = { status: "pending" as const, self: true, direct: false };
    expect(allowed(own, { manager: false, creator: false })).toEqual(["answer"]);
    expect(allowed({ ...own, self: false }, { manager: false, creator: true })).toEqual([
      "cancelInvitation",
    ]);
    expect(allowed({ ...own, self: false }, { manager: true, creator: false })).toEqual([
      "remove",
      "cancelInvitation",
    ]);
  });

  it("lets a participant withdraw and change their own dates", () => {
    expect(
      allowed(
        { status: "accepted", self: true, direct: false },
        { manager: false, creator: false },
      ),
    ).toEqual(["withdraw", "changeDates"]);
  });

  it("has a manager change a direct participant's dates but propose to an invited one", () => {
    const manager = { manager: true, creator: false };
    expect(allowed({ status: "accepted", self: false, direct: true }, manager)).toEqual([
      "remove",
      "changeDates",
    ]);
    expect(allowed({ status: "accepted", self: false, direct: false }, manager)).toEqual([
      "remove",
      "proposeDates",
    ]);
    expect(
      allowed(
        { status: "accepted", self: false, direct: false },
        { manager: false, creator: true },
      ),
    ).toEqual(["proposeDates"]);
  });

  it("allows nothing once the vacation ended or was cancelled", () => {
    for (const status of ["ended", "cancelled"] as const) {
      expect(
        canOnParticipant(
          "withdraw",
          status,
          { status: "accepted", self: true, direct: true },
          { manager: true, creator: true },
        ),
      ).toBe(false);
    }
  });
});
