import { describe, expect, it } from "vitest";

import { choreActions, chorePermissions, decideChoreAction } from "./chores";
import { type DelegableCapability, type HomeMembershipFacts, type HomeRole } from "./home";

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const OTHER_HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0002";

function membership(
  role: HomeRole,
  granted: readonly DelegableCapability[] = [],
  homeId = HOME,
): HomeMembershipFacts {
  return { homeId, role, grantedCapabilities: new Set(granted) };
}

type Expected = { readonly [A in (typeof choreActions)[number]]: boolean };

const member: Expected = {
  "chore.view": true,
  "chore.complete": true,
  "chore.tickStep": true,
  "chore.skip": false,
  "chore.reopen": false,
  "chore.edit": false,
  "chore.pause": false,
  "chore.delete": false,
  "chore.manageCategories": false,
  "chore.manageTemplates": false,
  "chore.bulk": false,
  "chore.correct": false,
  "chore.review": false,
};
const reviewer: Expected = { ...member, "chore.review": true };
const manager: Expected = {
  "chore.view": true,
  "chore.complete": true,
  "chore.tickStep": true,
  "chore.skip": true,
  "chore.reopen": true,
  "chore.edit": true,
  "chore.pause": true,
  "chore.delete": true,
  "chore.manageCategories": true,
  "chore.manageTemplates": true,
  "chore.bulk": true,
  "chore.correct": true,
  "chore.review": false,
};
const owner: Expected = { ...manager, "chore.review": true };

// The policy as a table (S20 brief default). Every row lists every action.
const rows: readonly {
  readonly who: string;
  readonly membership: HomeMembershipFacts;
  readonly expected: Expected;
}[] = [
  { who: "Owner", membership: membership("owner"), expected: owner },
  {
    who: "Administrator with manageHomeChores",
    membership: membership("administrator", ["manageHomeChores"]),
    expected: manager,
  },
  {
    who: "Administrator with approveHomeChores only",
    membership: membership("administrator", ["approveHomeChores"]),
    expected: reviewer,
  },
  {
    who: "Administrator with both",
    membership: membership("administrator", ["manageHomeChores", "approveHomeChores"]),
    expected: owner,
  },
  {
    who: "Administrator with only manageHomeTasks",
    membership: membership("administrator", ["manageHomeTasks"]),
    expected: member,
  },
  {
    who: "Administrator without grants",
    membership: membership("administrator"),
    expected: member,
  },
  // A Member is never a chore manager, even if a grant were recorded for them.
  {
    who: "Member with a stray grant",
    membership: membership("member", ["manageHomeChores", "approveHomeChores"]),
    expected: member,
  },
  { who: "Member", membership: membership("member"), expected: member },
];

describe("chore permission matrix", () => {
  it.each(rows)("$who", ({ membership: facts, expected }) => {
    for (const action of choreActions) {
      expect(decideChoreAction({ homeId: HOME }, facts, action).allowed, action).toBe(
        expected[action],
      );
    }
    expect(chorePermissions({ homeId: HOME }, facts)).toEqual(expected);
  });

  it("refuses everything without a membership of the chore's Home", () => {
    for (const facts of [null, membership("owner", [], OTHER_HOME)]) {
      for (const action of choreActions) {
        expect(decideChoreAction({ homeId: HOME }, facts, action)).toEqual({
          allowed: false,
          reason: "not-member",
        });
      }
    }
  });
});
