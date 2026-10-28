import { describe, expect, it } from "vitest";

import type { HomeMembershipFacts } from "./home";
import { decideMealAction, mealAccess, mealPermissions } from "./meals";

const home = (memberAccess: "edit" | "view") => ({
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

describe("meal planner permissions", () => {
  it("lets the Personal owner do everything", () => {
    expect(mealAccess({ context: "personal" }, null)).toBe("manage");
  });

  it("follows the Home's member access for members", () => {
    expect(mealAccess(home("edit"), membership("member"))).toBe("edit");
    expect(mealAccess(home("view"), membership("member"))).toBe("view");
    expect(decideMealAction(home("view"), membership("member"), "meals.plan")).toEqual({
      allowed: false,
      reason: "not-permitted",
    });
    expect(decideMealAction(home("view"), membership("member"), "meals.view").allowed).toBe(true);
  });

  it("makes the Owner and granted Administrators meal managers", () => {
    expect(mealAccess(home("view"), membership("owner"))).toBe("manage");
    expect(mealAccess(home("view"), membership("administrator"))).toBe("view");
    expect(mealAccess(home("view"), membership("administrator", ["manageHomeMeals"]))).toBe(
      "manage",
    );
    expect(mealAccess(home("edit"), membership("administrator", ["manageHomeShopping"]))).toBe(
      "edit",
    );
  });

  it("never counts another Home's membership", () => {
    expect(mealAccess(home("edit"), membership("owner", [], "h2"))).toBeNull();
    expect(decideMealAction(home("edit"), null, "meals.view")).toEqual({
      allowed: false,
      reason: "not-member",
    });
  });

  it("projects every action for the interface", () => {
    expect(mealPermissions("edit")).toEqual({
      "meals.view": true,
      "meals.plan": true,
      "meals.manage": false,
    });
    expect(mealPermissions(null)).toEqual({
      "meals.view": false,
      "meals.plan": false,
      "meals.manage": false,
    });
  });
});
