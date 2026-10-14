import { describe, expect, it } from "vitest";

import {
  decideHomeAction,
  delegableCapabilities,
  homeActions,
  homePermissions,
  homeRoles,
  isHomeRole,
  type DelegableCapability,
  type HomeAction,
  type HomeMembershipFacts,
  type HomeRole,
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
    [[], ["manageHomeSettings"], ["manageInvitations"]].map((granted) => {
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
          "home.invitations.manage": owner || (admin && has("manageInvitations")),
          // Owner-only, whatever was granted.
          "home.invitations.manageAdministrators": owner,
          // Every member sees the directory and edits only their own presentation.
          "home.members.view": true,
          "home.profile.editOwn": true,
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
