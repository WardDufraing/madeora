import type { DelegableCapability, HomeRole } from "@madeora/domain/permissions";

import { oraToolCatalogue } from "./catalogue";
import { availableTools, runTool } from "./registry";
import type { OraToolContext } from "./types";

const HOME_A = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const HOME_B = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0002";

function home(role: HomeRole, grants: readonly DelegableCapability[] = []): OraToolContext {
  return {
    home: {
      id: HOME_A,
      membership: { homeId: HOME_A, role, grantedCapabilities: new Set(grants) },
    },
  };
}
const personal: OraToolContext = { home: null };
const ids = (context: OraToolContext) => availableTools(context).map((tool) => tool.id);

describe("Ora tools: what each person may use", () => {
  it("offers a Member the everyday pages but none of the management pages", () => {
    const offered = ids(home("member"));
    expect(offered).toEqual(
      expect.arrayContaining(["open-tasks", "open-chores", "open-shopping", "open-calendar"]),
    );
    expect(offered).toContain("open-members");
    for (const managed of ["open-invitations", "open-displays", "open-home-settings"]) {
      expect(offered).not.toContain(managed);
    }
  });

  it("offers the Owner the management pages too", () => {
    expect(ids(home("owner"))).toEqual(
      expect.arrayContaining(["open-invitations", "open-displays", "open-home-settings"]),
    );
  });

  it("gives an Administrator only what the Owner granted", () => {
    expect(ids(home("administrator"))).not.toContain("open-home-settings");
    expect(ids(home("administrator"))).not.toContain("open-invitations");
    expect(ids(home("administrator", ["manageHomeSettings"]))).toEqual(
      expect.arrayContaining(["open-home-settings", "open-displays"]),
    );
    expect(ids(home("administrator", ["manageHomeSettings"]))).not.toContain("open-invitations");
    expect(ids(home("administrator", ["manageInvitations"]))).toContain("open-invitations");
  });

  it("never offers a tool the permission engine refuses, for any role and grant", () => {
    const grantSets: DelegableCapability[][] = [[], ["manageHomeSettings"], ["manageInvitations"]];
    for (const role of ["owner", "administrator", "member"] as const) {
      for (const grants of grantSets) {
        const context = home(role, grants);
        const offered = new Set(ids(context));
        for (const tool of oraToolCatalogue) {
          if (tool.requires.scope !== "home") continue;
          const run = runTool(context, tool.id);
          expect(run.status === "ok", `${role}/${grants.join()}/${tool.id}`).toBe(
            offered.has(tool.id),
          );
        }
      }
    }
  });

  it("offers Personal space only personal pages, and a Home only Home pages", () => {
    const inPersonal = ids(personal);
    expect(inPersonal).toEqual(expect.arrayContaining(["open-tasks", "open-calendar"]));
    for (const homeOnly of ["open-chores", "open-shopping", "open-members", "open-home-settings"]) {
      expect(inPersonal).not.toContain(homeOnly);
    }
    // The same id leads to a different page in each place.
    const personalTasks = runTool(personal, "open-tasks");
    const homeTasks = runTool(home("member"), "open-tasks");
    expect(personalTasks).toEqual({ status: "ok", output: { kind: "navigate", href: "/tasks" } });
    expect(homeTasks).toEqual({
      status: "ok",
      output: { kind: "navigate", href: `/homes/${HOME_A}/tasks` },
    });
  });
});

describe("Ora tools: running one", () => {
  it("refuses a tool the person may not use, exactly like one that does not exist", () => {
    const denied = runTool(home("member"), "open-home-settings");
    expect(denied).toEqual({ status: "forbidden" });
    expect(runTool(home("member"), "does-not-exist")).toEqual(denied);
    expect(runTool(personal, "open-chores")).toEqual(denied);
  });

  it("only ever names the Home it was resolved for", () => {
    const result = runTool(home("owner"), "open-home-settings");
    expect(result).toEqual({
      status: "ok",
      output: { kind: "navigate", href: `/homes/${HOME_A}/settings` },
    });
    expect(JSON.stringify(result)).not.toContain(HOME_B);
  });

  it("does not run prototype keys or inherited names as tools", () => {
    for (const id of ["__proto__", "constructor", "toString", "", "OPEN-TASKS"]) {
      expect(runTool(home("owner"), id)).toEqual({ status: "forbidden" });
    }
  });

  it("answers the capabilities guide with exactly the tools available to the caller", () => {
    const result = runTool(home("member"), "capabilities");
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.output.kind !== "capabilities") throw new Error("no list");
    expect(result.output.tools).toEqual(availableTools(home("member")));
    expect(result.output.tools.map((tool) => tool.id)).not.toContain("open-home-settings");
    // Available everywhere, signed in.
    expect(runTool(personal, "capabilities").status).toBe("ok");
  });

  it("has no tool that changes data yet", () => {
    for (const tool of oraToolCatalogue) expect(["navigate", "read"]).toContain(tool.kind);
  });

  it("keeps ids unique within each place", () => {
    for (const scope of ["personal", "home", "any"] as const) {
      const inScope = oraToolCatalogue.filter((tool) => tool.requires.scope === scope);
      expect(new Set(inScope.map((tool) => tool.id)).size).toBe(inScope.length);
    }
  });
});

describe("Ora tool ids", () => {
  it("lists exactly the ids the catalogue defines, for the label dictionary", async () => {
    const { oraToolIds } = await import("./ids");
    expect([...new Set(oraToolCatalogue.map((tool) => tool.id))].sort()).toEqual(
      [...oraToolIds].sort(),
    );
  });
});
