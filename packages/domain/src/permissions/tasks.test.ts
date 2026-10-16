import { describe, expect, it } from "vitest";

import { type DelegableCapability, type HomeMembershipFacts, type HomeRole } from "./home";
import { decideTaskAction, taskActions, taskPermissions, type TaskFacts } from "./tasks";

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const OTHER_HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0002";

function membership(
  role: HomeRole,
  granted: readonly DelegableCapability[] = [],
  homeId = HOME,
): HomeMembershipFacts {
  return { homeId, role, grantedCapabilities: new Set(granted) };
}

function homeTask(relation: "creator" | "assignee" | "none"): TaskFacts {
  return {
    context: "home",
    homeId: HOME,
    createdByMe: relation === "creator",
    assignedToMe: relation === "assignee",
  };
}

// The policy as a table (S18 brief default). Every role/grant/relation row lists every action.
const rows: readonly {
  readonly who: string;
  readonly membership: HomeMembershipFacts;
  readonly relation: "creator" | "assignee" | "none";
  readonly expected: { readonly [A in (typeof taskActions)[number]]: boolean };
}[] = [
  ...(["creator", "assignee", "none"] as const).flatMap((relation) => {
    const creator = relation === "creator";
    const assignee = relation === "assignee";
    const plain = {
      "task.view": true,
      "task.comment": true,
      "task.edit": creator || assignee,
      "task.complete": creator || assignee,
      "task.assign": false,
      "task.delete": creator,
    };
    const manager = {
      "task.view": true,
      "task.comment": true,
      "task.edit": true,
      "task.complete": true,
      "task.assign": true,
      "task.delete": true,
    };
    return [
      { who: "Owner", membership: membership("owner"), relation, expected: manager },
      {
        who: "Administrator with manageHomeTasks",
        membership: membership("administrator", ["manageHomeTasks"]),
        relation,
        expected: manager,
      },
      {
        who: "Administrator with other grants",
        membership: membership("administrator", [
          "manageHomeSettings",
          "manageHomeDashboard",
          "manageInvitations",
          "removeMembers",
        ]),
        relation,
        expected: plain,
      },
      { who: "Member", membership: membership("member"), relation, expected: plain },
      {
        who: "Member holding a grant (grants count for Administrators only)",
        membership: membership("member", ["manageHomeTasks"]),
        relation,
        expected: plain,
      },
    ];
  }),
];

describe("task permission matrix", () => {
  for (const row of rows) {
    for (const action of taskActions) {
      it(`${row.who}, ${row.relation}: ${action} is ${row.expected[action] ? "allowed" : "refused"}`, () => {
        expect(decideTaskAction(homeTask(row.relation), row.membership, action).allowed).toBe(
          row.expected[action],
        );
      });
    }
  }

  it("projects the same answers", () => {
    for (const row of rows) {
      expect(taskPermissions(homeTask(row.relation), row.membership)).toEqual(row.expected);
    }
  });
});

describe("outside the Home", () => {
  it.each(taskActions)("refuses %s without a membership", (action) => {
    expect(decideTaskAction(homeTask("creator"), null, action)).toEqual({
      allowed: false,
      reason: "not-member",
    });
  });

  it.each(taskActions)("refuses %s to the Owner of another Home", (action) => {
    expect(
      decideTaskAction(homeTask("assignee"), membership("owner", [], OTHER_HOME), action),
    ).toEqual({ allowed: false, reason: "not-member" });
  });
});

describe("personal tasks", () => {
  it("lets their owner do everything but assign", () => {
    expect(taskPermissions({ context: "personal", ownedByMe: true }, null)).toEqual({
      "task.view": true,
      "task.edit": true,
      "task.complete": true,
      "task.assign": false,
      "task.delete": true,
      "task.comment": true,
    });
  });

  it.each(taskActions)("refuses %s to anyone else, whatever Home role they hold", (action) => {
    expect(
      decideTaskAction({ context: "personal", ownedByMe: false }, membership("owner"), action),
    ).toEqual({ allowed: false, reason: "not-member" });
  });
});
