import { describe, expect, it } from "vitest";

import { decideGoalAction, goalAccess, goalPermissions } from "./goals";
import type { HomeMembershipFacts } from "./home";

const home = (memberAccess: "contribute" | "view") => ({
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

describe("goal permissions", () => {
  it("lets the owner of a personal goal do everything", () => {
    expect(goalAccess({ context: "personal" }, null)).toBe("manage");
  });

  it("follows the Home's member access for members", () => {
    expect(goalAccess(home("contribute"), membership("member"))).toBe("contribute");
    expect(goalAccess(home("view"), membership("member"))).toBe("view");
    expect(decideGoalAction(home("view"), membership("member"), "goals.contribute")).toEqual({
      allowed: false,
      reason: "not-permitted",
    });
    expect(decideGoalAction(home("contribute"), membership("member"), "goals.manage")).toEqual({
      allowed: false,
      reason: "not-permitted",
    });
    expect(decideGoalAction(home("view"), membership("member"), "goals.view").allowed).toBe(true);
  });

  it("makes the Owner and Administrators granted manageHomeGoals goal managers", () => {
    expect(goalAccess(home("view"), membership("owner"))).toBe("manage");
    expect(goalAccess(home("view"), membership("administrator"))).toBe("view");
    expect(goalAccess(home("view"), membership("administrator", ["manageHomeGoals"]))).toBe(
      "manage",
    );
    expect(goalAccess(home("contribute"), membership("administrator", ["manageHomeHabits"]))).toBe(
      "contribute",
    );
  });

  it("never counts another Home's membership", () => {
    expect(goalAccess(home("contribute"), membership("owner", [], "h2"))).toBeNull();
    expect(decideGoalAction(home("contribute"), null, "goals.view")).toEqual({
      allowed: false,
      reason: "not-member",
    });
  });

  it("projects every action for the interface", () => {
    expect(goalPermissions("contribute")).toEqual({
      "goals.view": true,
      "goals.contribute": true,
      "goals.manage": false,
    });
    expect(goalPermissions(null)).toEqual({
      "goals.view": false,
      "goals.contribute": false,
      "goals.manage": false,
    });
  });
});
