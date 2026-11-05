import { describe, expect, it } from "vitest";

import {
  calendarLevel,
  calendarPermissions,
  canChangeCalendarLevel,
  decideCalendarEventAction,
} from "./calendar";
import type { HomeMembershipFacts } from "./home";

const membership = (
  role: HomeMembershipFacts["role"],
  granted: readonly string[] = [],
  homeId = "h1",
): HomeMembershipFacts => ({
  homeId,
  role,
  grantedCapabilities: new Set(granted) as HomeMembershipFacts["grantedCapabilities"],
});

describe("calendar levels", () => {
  it("starts every member and Administrator at edit, and the Owner at manage", () => {
    expect(calendarLevel("h1", membership("member"), null)).toBe("edit");
    expect(calendarLevel("h1", membership("administrator"), null)).toBe("edit");
    expect(calendarLevel("h1", membership("owner"), "view")).toBe("manage");
  });

  it("makes an Administrator a manager only through manageHomeCalendar, whatever is stored", () => {
    expect(calendarLevel("h1", membership("administrator", ["manageHomeCalendar"]), "view")).toBe(
      "manage",
    );
    expect(calendarLevel("h1", membership("administrator", ["manageHomePets"]), "view")).toBe(
      "view",
    );
  });

  it("gives nothing outside the person's own Home", () => {
    expect(calendarLevel("h1", null, "edit_delete")).toBeNull();
    expect(calendarLevel("h1", membership("owner", [], "h2"), null)).toBeNull();
    expect(calendarPermissions(null)).toEqual({
      "calendar.view": false,
      "calendar.edit": false,
      "calendar.delete": false,
      "calendar.manage": false,
    });
  });

  it("keeps editing and deleting separate", () => {
    expect(calendarPermissions("edit")).toEqual({
      "calendar.view": true,
      "calendar.edit": true,
      "calendar.delete": false,
      "calendar.manage": false,
    });
    expect(calendarPermissions("edit_delete")["calendar.delete"]).toBe(true);
    expect(calendarPermissions("edit_delete")["calendar.manage"]).toBe(false);
    expect(calendarPermissions("view")["calendar.edit"]).toBe(false);
  });
});

describe("calendar events", () => {
  it("leaves a personal event to its owner, read-only for anyone it is shared with", () => {
    const mine = { owner: "personal", ownedByViewer: true } as const;
    const shared = { owner: "personal", ownedByViewer: false } as const;
    expect(decideCalendarEventAction(mine, "calendar.delete").allowed).toBe(true);
    expect(decideCalendarEventAction(shared, "calendar.view").allowed).toBe(true);
    expect(decideCalendarEventAction(shared, "calendar.edit").allowed).toBe(false);
    expect(decideCalendarEventAction(shared, "calendar.delete").allowed).toBe(false);
  });

  it("decides a Home event by the viewer's level, never by who created it", () => {
    expect(decideCalendarEventAction({ owner: "home", level: "edit" }, "calendar.edit")).toEqual({
      allowed: true,
    });
    expect(decideCalendarEventAction({ owner: "home", level: "edit" }, "calendar.delete")).toEqual({
      allowed: false,
      reason: "not-permitted",
    });
    expect(decideCalendarEventAction({ owner: "home", level: null }, "calendar.view")).toEqual({
      allowed: false,
      reason: "not-member",
    });
  });
});

describe("setting levels", () => {
  it("is for managers, never on themselves or another manager", () => {
    expect(canChangeCalendarLevel("manage", { isSelf: false, level: "edit" })).toBe(true);
    expect(canChangeCalendarLevel("manage", { isSelf: true, level: "manage" })).toBe(false);
    expect(canChangeCalendarLevel("manage", { isSelf: false, level: "manage" })).toBe(false);
    expect(canChangeCalendarLevel("edit_delete", { isSelf: false, level: "view" })).toBe(false);
  });
});
