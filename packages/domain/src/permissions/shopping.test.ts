import { describe, expect, it } from "vitest";

import { type DelegableCapability, type HomeMembershipFacts, type HomeRole } from "./home";
import {
  accessAllows,
  decideShoppingAction,
  shoppingAccess,
  shoppingActions,
  shoppingPermissions,
  type ShoppingListFacts,
  type ShoppingMemberAccess,
} from "./shopping";

const HOME = "7a3b2c1d-1d7a-4b8e-9c55-2b2f6b0a0001";
const OTHER_HOME = "7a3b2c1d-1d7a-4b8e-9c55-2b2f6b0a0002";

function membership(
  role: HomeRole,
  granted: readonly DelegableCapability[] = [],
  homeId = HOME,
): HomeMembershipFacts {
  return { homeId, role, grantedCapabilities: new Set(granted) };
}

const homeList = (
  memberAccess: ShoppingMemberAccess = "edit",
  createdByMe = false,
  archived = false,
): ShoppingListFacts => ({ context: "home", homeId: HOME, createdByMe, memberAccess, archived });

describe("shoppingAccess", () => {
  it("gives the Personal space's owner everything and nobody else anything", () => {
    expect(shoppingAccess({ context: "personal", ownedByMe: true, archived: false }, null)).toBe(
      "manage",
    );
    expect(
      shoppingAccess(
        { context: "personal", ownedByMe: false, archived: false },
        membership("owner"),
      ),
    ).toBeNull();
  });

  it("follows the brief's table for Home lists", () => {
    const cases: readonly [string, HomeMembershipFacts | null, ShoppingListFacts, string | null][] =
      [
        ["Owner", membership("owner"), homeList("view"), "manage"],
        [
          "Administrator with manageHomeShopping",
          membership("administrator", ["manageHomeShopping"]),
          homeList("view"),
          "manage",
        ],
        [
          "Administrator with every other grant",
          membership("administrator", [
            "manageHomeRecipes",
            "manageHomeTasks",
            "manageHomeSettings",
          ]),
          homeList("check"),
          "check",
        ],
        ["Member, edit", membership("member"), homeList("edit"), "edit"],
        ["Member, check", membership("member"), homeList("check"), "check"],
        ["Member, view", membership("member"), homeList("view"), "view"],
        ["The list's creator", membership("member"), homeList("view", true), "manage"],
        [
          "A grant held by a Member is ignored",
          membership("member", ["manageHomeShopping"]),
          homeList("view"),
          "view",
        ],
        ["Not a member", null, homeList("edit"), null],
        ["Another Home's membership", membership("owner", [], OTHER_HOME), homeList("edit"), null],
        ["A creator who left", null, homeList("edit", true), null],
      ];
    for (const [label, member, list, expected] of cases) {
      expect(shoppingAccess(list, member), label).toBe(expected);
    }
  });
});

describe("decideShoppingAction", () => {
  it("allows each level its own actions and those below it", () => {
    const member = membership("member");
    expect(shoppingPermissions(homeList("view"), member)).toEqual({
      "shopping.view": true,
      "shopping.check": false,
      "shopping.edit": false,
      "shopping.manage": false,
    });
    expect(shoppingPermissions(homeList("check"), member)).toEqual({
      "shopping.view": true,
      "shopping.check": true,
      "shopping.edit": false,
      "shopping.manage": false,
    });
    expect(shoppingPermissions(homeList("edit"), member)).toEqual({
      "shopping.view": true,
      "shopping.check": true,
      "shopping.edit": true,
      "shopping.manage": false,
    });
  });

  it("makes an archived list read only, while its managers may still restore it", () => {
    const owner = membership("owner");
    const archived = homeList("edit", false, true);
    expect(decideShoppingAction(archived, owner, "shopping.check").allowed).toBe(false);
    expect(decideShoppingAction(archived, owner, "shopping.edit").allowed).toBe(false);
    expect(decideShoppingAction(archived, owner, "shopping.manage").allowed).toBe(true);
    expect(decideShoppingAction(archived, owner, "shopping.view").allowed).toBe(true);
  });

  it("hides a list from someone who is not a member, whatever the action", () => {
    for (const action of shoppingActions) {
      expect(decideShoppingAction(homeList("edit"), null, action)).toEqual({
        allowed: false,
        reason: "not-member",
      });
    }
  });

  it("answers from a level as accessAllows does", () => {
    expect(accessAllows("check", false, "shopping.check")).toBe(true);
    expect(accessAllows("check", false, "shopping.edit")).toBe(false);
    expect(accessAllows("manage", true, "shopping.edit")).toBe(false);
    expect(accessAllows("manage", true, "shopping.manage")).toBe(true);
  });
});
