import { describe, expect, it } from "vitest";

import { type DelegableCapability, type HomeMembershipFacts, type HomeRole } from "./home";
import { decideRecipeAction, recipeActions, recipePermissions, type RecipeFacts } from "./recipes";

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const OTHER_HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0002";

function membership(
  role: HomeRole,
  granted: readonly DelegableCapability[] = [],
  homeId = HOME,
): HomeMembershipFacts {
  return { homeId, role, grantedCapabilities: new Set(granted) };
}

const homeRecipe = (createdByMe: boolean): RecipeFacts => ({
  status: "published",
  context: "home",
  homeId: HOME,
  createdByMe,
});

describe("decideRecipeAction", () => {
  // The S24 brief's table: every role, grant and relation lists every action.
  const managers: readonly [string, HomeMembershipFacts][] = [
    ["Owner", membership("owner")],
    ["Administrator with manageHomeRecipes", membership("administrator", ["manageHomeRecipes"])],
  ];
  const plain: readonly [string, HomeMembershipFacts][] = [
    [
      "Administrator with every other grant",
      membership("administrator", [
        "manageHomeSettings",
        "manageHomeTasks",
        "manageHomeChores",
        "manageHomeDashboard",
        "manageHomeRewards",
        "manageHomePoints",
      ]),
    ],
    ["Member", membership("member")],
    [
      "Member holding a grant (grants count for Administrators only)",
      membership("member", ["manageHomeRecipes"]),
    ],
  ];

  for (const createdByMe of [true, false]) {
    for (const [who, facts] of managers) {
      it(`${who}, creator=${String(createdByMe)}: everything but publish`, () => {
        expect(recipePermissions(homeRecipe(createdByMe), facts)).toEqual({
          "recipe.view": true,
          "recipe.edit": true,
          "recipe.delete": true,
          "recipe.rate": true,
          "recipe.favorite": true,
          "recipe.publish": false,
          "recipe.share": true,
          "recipe.unshare": true,
        });
      });
    }
    for (const [who, facts] of plain) {
      it(`${who}, creator=${String(createdByMe)}: edits and deletes only their own`, () => {
        expect(recipePermissions(homeRecipe(createdByMe), facts)).toEqual({
          "recipe.view": true,
          "recipe.edit": createdByMe,
          "recipe.delete": createdByMe,
          "recipe.rate": true,
          "recipe.favorite": true,
          "recipe.publish": false,
          "recipe.share": false,
          "recipe.unshare": false,
        });
      });
    }
  }

  it("a creator who left the Home keeps nothing", () => {
    for (const action of recipeActions) {
      expect(decideRecipeAction(homeRecipe(true), null, action)).toEqual({
        allowed: false,
        reason: "not-member",
      });
    }
  });

  it("a membership of another Home never counts, even the Owner's", () => {
    for (const action of recipeActions) {
      expect(
        decideRecipeAction(homeRecipe(true), membership("owner", [], OTHER_HOME), action).allowed,
      ).toBe(false);
    }
  });

  it("a draft is its creator's alone, whatever their role", () => {
    const someoneElses: RecipeFacts = { status: "draft", createdByMe: false };
    for (const facts of [
      membership("owner"),
      membership("administrator", ["manageHomeRecipes"]),
      null,
    ]) {
      for (const action of recipeActions) {
        expect(decideRecipeAction(someoneElses, facts, action)).toEqual({
          allowed: false,
          reason: "not-member",
        });
      }
    }
    expect(recipePermissions({ status: "draft", createdByMe: true }, null)).toEqual({
      "recipe.view": true,
      "recipe.edit": true,
      "recipe.delete": true,
      "recipe.rate": false,
      "recipe.favorite": false,
      "recipe.publish": true,
      "recipe.share": false,
      "recipe.unshare": false,
    });
  });

  it("a personal recipe is its owner's", () => {
    const mine: RecipeFacts = { status: "published", context: "personal", ownedByMe: true };
    const theirs: RecipeFacts = { status: "published", context: "personal", ownedByMe: false };
    expect(recipePermissions(mine, null)).toEqual({
      "recipe.view": true,
      "recipe.edit": true,
      "recipe.delete": true,
      "recipe.rate": true,
      "recipe.favorite": true,
      "recipe.publish": false,
      "recipe.share": true,
      "recipe.unshare": true,
    });
    for (const action of recipeActions) {
      expect(decideRecipeAction(theirs, membership("owner"), action).allowed).toBe(false);
    }
  });
});

describe("shared recipes (S25)", () => {
  const sharedIn = (shareAllowsEdit: boolean): RecipeFacts => ({
    status: "published",
    context: "sharedIn",
    homeId: HOME,
    shareAllowsEdit,
  });

  it("a creator who is not a recipe manager may no longer delete a shared recipe", () => {
    const facts: RecipeFacts = {
      status: "published",
      context: "home",
      homeId: HOME,
      createdByMe: true,
      shared: true,
    };
    expect(decideRecipeAction(facts, membership("member"), "recipe.delete").allowed).toBe(false);
    expect(decideRecipeAction(facts, membership("member"), "recipe.edit").allowed).toBe(true);
    expect(decideRecipeAction(facts, membership("owner"), "recipe.delete").allowed).toBe(true);
  });

  it("in a destination, members view, rate and favorite; nobody deletes or shares onward", () => {
    for (const shareAllowsEdit of [true, false]) {
      for (const facts of [membership("member"), membership("owner")]) {
        const can = recipePermissions(sharedIn(shareAllowsEdit), facts);
        expect(can["recipe.view"] && can["recipe.rate"] && can["recipe.favorite"]).toBe(true);
        expect(can["recipe.delete"] || can["recipe.share"] || can["recipe.publish"]).toBe(false);
      }
    }
  });

  it("a destination's recipe managers edit only when the share allows it, and may remove it", () => {
    const manager = membership("administrator", ["manageHomeRecipes"]);
    expect(decideRecipeAction(sharedIn(true), manager, "recipe.edit").allowed).toBe(true);
    expect(decideRecipeAction(sharedIn(false), manager, "recipe.edit").allowed).toBe(false);
    expect(decideRecipeAction(sharedIn(true), membership("member"), "recipe.edit").allowed).toBe(
      false,
    );
    expect(decideRecipeAction(sharedIn(false), manager, "recipe.unshare").allowed).toBe(true);
    expect(
      decideRecipeAction(sharedIn(false), membership("member"), "recipe.unshare").allowed,
    ).toBe(false);
  });

  it("someone outside the destination sees nothing of it", () => {
    for (const action of recipeActions) {
      expect(decideRecipeAction(sharedIn(true), null, action)).toEqual({
        allowed: false,
        reason: "not-member",
      });
      expect(
        decideRecipeAction(sharedIn(true), membership("owner", [], OTHER_HOME), action).allowed,
      ).toBe(false);
    }
  });
});
