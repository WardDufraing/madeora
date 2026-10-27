import { describe, expect, it } from "vitest";

import {
  decideHomeAction,
  decideMemberAction,
  delegableCapabilities,
  homeActions,
  homePermissions,
  homeRoles,
  isDelegableCapability,
  isHomeRole,
  memberActions,
  memberPermissions,
  type DelegableCapability,
  type HomeAction,
  type HomeMembershipFacts,
  type HomeRole,
  type MemberAction,
} from "./home";

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const OTHER_HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0002";

function membership(
  role: HomeRole,
  granted: readonly DelegableCapability[] = [],
  homeId = HOME,
): HomeMembershipFacts {
  return { homeId, role, grantedCapabilities: new Set(granted) };
}

// The whole policy as a table: role, grants, and the expected answer for every action. A new
// action or role fails the "every combination" test below until it is added here.
const matrix: readonly {
  readonly role: HomeRole;
  readonly granted: readonly DelegableCapability[];
  readonly expected: { readonly [A in HomeAction]: boolean };
}[] = [
  ...(["owner", "administrator", "member"] as const).flatMap((role) =>
    [
      [],
      ["manageHomeSettings"],
      ["manageInvitations"],
      ["removeMembers"],
      ["manageHomeDashboard"],
      ["manageHomeTasks"],
      ["manageHomeChores"],
      ["approveHomeChores"],
      ["manageHomeRewards"],
      ["approveHomeRewards"],
      ["manageHomePoints"],
      ["manageHomeRecipes"],
    ].map((granted) => {
      const owner = role === "owner";
      const admin = role === "administrator";
      const has = (capability: DelegableCapability) =>
        (granted as readonly DelegableCapability[]).includes(capability);
      return {
        role,
        granted: granted as readonly DelegableCapability[],
        expected: {
          "home.view": true,
          "home.updateSettings": owner || (admin && has("manageHomeSettings")),
          "home.storage.view": owner || (admin && has("manageHomeSettings")),
          // Every member opens the Home trash; the whole of it only the Owner and storage managers.
          "home.trash.view": true,
          "home.trash.viewAll": owner || (admin && has("manageHomeSettings")),
          "home.invitations.manage": owner || (admin && has("manageInvitations")),
          // Owner-only, whatever was granted.
          "home.invitations.manageAdministrators": owner,
          // Every member sees the directory and edits only their own presentation.
          "home.members.view": true,
          "home.profile.editOwn": true,
          // Owner-only powers, whatever was granted.
          "home.members.manageRoles": owner,
          "home.members.manageCapabilities": owner,
          "home.ownership.transfer": owner,
          "home.members.remove": owner || (admin && has("removeMembers")),
          // Everyone but the Owner may leave at any time.
          "home.leave": !owner,
          // Recovery: anyone but the Owner may ask; only the Owner cancels; anyone objects.
          // Grants never change these.
          "home.recovery.request": !owner,
          "home.recovery.cancel": owner,
          "home.recovery.object": true,
          // Every member sees the Home dashboard; the Owner and granted Administrators arrange it.
          "home.dashboard.view": true,
          "home.dashboard.edit": owner || (admin && has("manageHomeDashboard")),
          // Every member sees, creates and comments on Home tasks; task managers manage them.
          "home.tasks.view": true,
          "home.tasks.create": true,
          "home.tasks.comment": true,
          "home.tasks.manage": owner || (admin && has("manageHomeTasks")),
          // Every member sees chores and completes any occurrence; chore managers manage them.
          "home.chores.view": true,
          "home.chores.complete": true,
          "home.chores.manage": owner || (admin && has("manageHomeChores")),
          "home.chores.review": owner || (admin && has("approveHomeChores")),
          // Every member has their own points; balances of others and rewards are managed apart.
          "home.points.view": true,
          "home.points.manage": owner || (admin && has("manageHomePoints")),
          "home.rewards.manage": owner || (admin && has("manageHomeRewards")),
          "home.rewards.approve": owner || (admin && has("approveHomeRewards")),
          // Every member sees, creates and publishes recipes; recipe managers edit and delete any.
          "home.recipes.view": true,
          "home.recipes.create": true,
          "home.recipes.manage": owner || (admin && has("manageHomeRecipes")),
        },
      };
    }),
  ),
];

// The rule above spelled out for the cases that matter most, so a change to the generator cannot
// silently weaken them.
describe("Home permission matrix, explicit cases", () => {
  it("never lets a Member or Administrator invite Administrators, whatever they hold", () => {
    for (const role of ["member", "administrator"] as const) {
      expect(
        decideHomeAction(
          HOME,
          membership(role, [...delegableCapabilities]),
          "home.invitations.manageAdministrators",
        ).allowed,
      ).toBe(false);
    }
  });

  it("lets an Administrator manage Member invitations only with the granted capability", () => {
    expect(
      decideHomeAction(HOME, membership("administrator"), "home.invitations.manage").allowed,
    ).toBe(false);
    expect(
      decideHomeAction(
        HOME,
        membership("administrator", ["manageInvitations"]),
        "home.invitations.manage",
      ).allowed,
    ).toBe(true);
    expect(
      decideHomeAction(HOME, membership("member", ["manageInvitations"]), "home.invitations.manage")
        .allowed,
    ).toBe(false);
  });
});

describe("Home permission matrix", () => {
  it("covers every role with and without every capability", () => {
    for (const role of homeRoles) {
      expect(matrix.some((row) => row.role === role && row.granted.length === 0)).toBe(true);
      for (const capability of delegableCapabilities) {
        expect(matrix.some((row) => row.role === role && row.granted.includes(capability))).toBe(
          true,
        );
      }
    }
  });

  for (const row of matrix) {
    for (const action of homeActions) {
      const grants = row.granted.length > 0 ? ` with ${row.granted.join(", ")}` : "";
      it(`${row.role}${grants}: ${action} is ${row.expected[action] ? "allowed" : "refused"}`, () => {
        const decision = decideHomeAction(HOME, membership(row.role, row.granted), action);
        expect(decision.allowed).toBe(row.expected[action]);
        if (!decision.allowed) expect(decision.reason).toBe("not-permitted");
      });
    }
  }
});

describe("decideHomeAction outside a membership", () => {
  it.each(homeActions)("refuses %s without a membership", (action) => {
    expect(decideHomeAction(HOME, null, action)).toEqual({ allowed: false, reason: "not-member" });
  });

  it.each(homeRoles)(
    "refuses everything in Home B to a %s of Home A (a role never crosses Homes)",
    (role) => {
      for (const action of homeActions) {
        expect(
          decideHomeAction(OTHER_HOME, membership(role, [...delegableCapabilities]), action),
        ).toEqual({ allowed: false, reason: "not-member" });
      }
    },
  );
});

describe("homePermissions", () => {
  it("projects the same answers as decideHomeAction", () => {
    for (const row of matrix) {
      expect(homePermissions(membership(row.role, row.granted))).toEqual(row.expected);
    }
  });
});

describe("isHomeRole", () => {
  it.each(["owner", "administrator", "member"])("accepts %s", (value) => {
    expect(isHomeRole(value)).toBe(true);
  });

  it.each(["Owner", "admin", "guest", "display", "", null, undefined, 1])("refuses %s", (value) => {
    expect(isHomeRole(value)).toBe(false);
  });
});

describe("isDelegableCapability", () => {
  it.each(delegableCapabilities)("accepts %s", (value) => {
    expect(isDelegableCapability(value)).toBe(true);
  });

  it.each(["transferOwnership", "deleteHome", "manageAdministrators", "", null, 1])(
    "refuses %s",
    (value) => {
      expect(isDelegableCapability(value)).toBe(false);
    },
  );
});

describe("Owner-only powers stay Owner-only", () => {
  const ownerOnly: readonly HomeAction[] = [
    "home.members.manageRoles",
    "home.members.manageCapabilities",
    "home.ownership.transfer",
    "home.invitations.manageAdministrators",
  ];
  it.each(ownerOnly)("no capability lets an Administrator %s", (action) => {
    expect(
      decideHomeAction(HOME, membership("administrator", [...delegableCapabilities]), action)
        .allowed,
    ).toBe(false);
  });
});

// Member actions: every actor role and grant set against every target role, as self and not.
describe("decideMemberAction", () => {
  const grantSets: readonly (readonly DelegableCapability[])[] = [[], [...delegableCapabilities]];

  function expected(
    actor: HomeRole,
    granted: readonly DelegableCapability[],
    target: HomeRole,
    isSelf: boolean,
    action: MemberAction,
  ): boolean {
    if (isSelf || target === "owner") return false;
    const owner = actor === "owner";
    switch (action) {
      case "member.changeRole":
      case "member.nominateOwner":
        return owner;
      case "member.editCapabilities":
        return owner && target === "administrator";
      case "member.remove":
        return (
          owner ||
          (actor === "administrator" && granted.includes("removeMembers") && target === "member")
        );
    }
  }

  for (const actor of homeRoles) {
    for (const granted of grantSets) {
      for (const target of homeRoles) {
        for (const isSelf of [false, true]) {
          // An Owner acting on an Owner who is not themselves cannot exist (one Owner per Home),
          // but the rule must still refuse it.
          for (const action of memberActions) {
            const answer = expected(actor, granted, target, isSelf, action);
            const label = `${actor}${granted.length > 0 ? " with every grant" : ""} → ${
              isSelf ? "self as " : ""
            }${target}: ${action} is ${answer ? "allowed" : "refused"}`;
            it(label, () => {
              const decision = decideMemberAction(
                HOME,
                membership(actor, granted),
                { homeId: HOME, role: target, isSelf },
                action,
              );
              expect(decision.allowed).toBe(answer);
              if (!decision.allowed) expect(decision.reason).toBe("not-permitted");
            });
          }
        }
      }
    }
  }

  it("refuses a target in another Home, and an actor without a membership", () => {
    for (const action of memberActions) {
      expect(
        decideMemberAction(
          HOME,
          membership("owner"),
          { homeId: OTHER_HOME, role: "member", isSelf: false },
          action,
        ),
      ).toEqual({ allowed: false, reason: "not-member" });
      expect(
        decideMemberAction(HOME, null, { homeId: HOME, role: "member", isSelf: false }, action),
      ).toEqual({ allowed: false, reason: "not-member" });
      expect(
        decideMemberAction(
          HOME,
          membership("owner", [], OTHER_HOME),
          { homeId: HOME, role: "member", isSelf: false },
          action,
        ),
      ).toEqual({ allowed: false, reason: "not-member" });
    }
  });

  it("memberPermissions projects the same answers", () => {
    const actor = membership("administrator", ["removeMembers"]);
    expect(memberPermissions(actor, { homeId: HOME, role: "member", isSelf: false })).toEqual({
      "member.changeRole": false,
      "member.editCapabilities": false,
      "member.remove": true,
      "member.nominateOwner": false,
    });
    expect(
      memberPermissions(membership("owner"), {
        homeId: HOME,
        role: "administrator",
        isSelf: false,
      }),
    ).toEqual({
      "member.changeRole": true,
      "member.editCapabilities": true,
      "member.remove": true,
      "member.nominateOwner": true,
    });
  });
});
