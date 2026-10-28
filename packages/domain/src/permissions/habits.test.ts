import { describe, expect, it } from "vitest";

import { decideHabitAction, habitAccess, habitPermissions } from "./habits";
import type { HomeMembershipFacts } from "./home";

const home = (memberAccess: "complete" | "view") => ({
  context: "home" as const,
  homeId: "h1",
  memberAccess,
});
const membership = (
  role: HomeMembershipFacts["role"],
  granted: readonly string[] = [],
  homeId = "h1",
): HomeMembershipFacts => ({
  homeId,
  role,
  grantedCapabilities: new Set(granted) as HomeMembershipFacts["grantedCapabilities"],
});

describe("habit permissions", () => {
  it("lets the owner of a personal habit do everything", () => {
    expect(habitAccess({ context: "personal" }, null)).toBe("manage");
  });

  it("follows the Home's member access for members", () => {
    expect(habitAccess(home("complete"), membership("member"))).toBe("complete");
    expect(habitAccess(home("view"), membership("member"))).toBe("view");
    expect(decideHabitAction(home("view"), membership("member"), "habits.complete")).toEqual({
      allowed: false,
      reason: "not-permitted",
    });
    expect(decideHabitAction(home("complete"), membership("member"), "habits.manage")).toEqual({
      allowed: false,
      reason: "not-permitted",
    });
    expect(decideHabitAction(home("view"), membership("member"), "habits.view").allowed).toBe(true);
  });

  it("makes the Owner and granted Administrators habit managers", () => {
    expect(habitAccess(home("view"), membership("owner"))).toBe("manage");
    expect(habitAccess(home("view"), membership("administrator"))).toBe("view");
    expect(habitAccess(home("view"), membership("administrator", ["manageHomeHabits"]))).toBe(
      "manage",
    );
    expect(habitAccess(home("complete"), membership("administrator", ["manageHomeMeals"]))).toBe(
      "complete",
    );
  });

  it("never counts another Home's membership", () => {
    expect(habitAccess(home("complete"), membership("owner", [], "h2"))).toBeNull();
    expect(decideHabitAction(home("complete"), null, "habits.view")).toEqual({
      allowed: false,
      reason: "not-member",
    });
  });

  it("projects every action for the interface", () => {
    expect(habitPermissions("complete")).toEqual({
      "habits.view": true,
      "habits.complete": true,
      "habits.manage": false,
    });
    expect(habitPermissions(null)).toEqual({
      "habits.view": false,
      "habits.complete": false,
      "habits.manage": false,
    });
  });
});
