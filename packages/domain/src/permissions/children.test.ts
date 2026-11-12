import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CHILD_PRESET,
  childActions,
  childCapabilities,
  childPermissions,
  childPresetCapabilities,
  compareChildAccess,
  decideChildAction,
  effectiveChildCapabilities,
  suggestedPreset,
  type ChildFacts,
} from "./children";

const facts = (overrides: Partial<ChildFacts>): ChildFacts => ({
  homeRole: "member",
  guardianRole: null,
  hasPrimaryGuardian: true,
  ...overrides,
});

describe("child presets", () => {
  it("starts every child on the most restrictive preset", () => {
    expect(DEFAULT_CHILD_PRESET).toBe("young_child");
    const young = new Set(childPresetCapabilities.young_child);
    for (const capability of childPresetCapabilities.child) {
      expect(childPresetCapabilities.teen).toContain(capability);
    }
    for (const capability of young) expect(childPresetCapabilities.child).toContain(capability);
  });

  it("only suggests a preset from the age band", () => {
    expect(suggestedPreset(null)).toBe("young_child");
    expect(suggestedPreset("under_8")).toBe("young_child");
    expect(suggestedPreset("8_12")).toBe("child");
    expect(suggestedPreset("13_17")).toBe("teen");
  });

  it("applies overrides on top of the preset in both directions", () => {
    const result = effectiveChildCapabilities("young_child", {
      viewLeaderboard: false,
      redeemRewards: true,
    });
    expect(result).toContain("redeemRewards");
    expect(result).not.toContain("viewLeaderboard");
    expect(result).toContain("viewHomeChores");
  });

  it("keeps explicit overrides when the preset changes", () => {
    const overrides = { viewLeaderboard: false } as const;
    expect(effectiveChildCapabilities("teen", overrides)).not.toContain("viewLeaderboard");
  });

  it("previews added and removed capabilities and flags widening", () => {
    const before = effectiveChildCapabilities("child", {});
    const after = effectiveChildCapabilities("teen", { viewPets: false });
    const change = compareChildAccess(before, after);
    expect(change.added.toSorted()).toEqual(["editOwnDisplayName", "editShopping"]);
    expect(change.removed).toEqual(["viewPets"]);
    expect(change.widens).toBe(true);
    expect(compareChildAccess(after, before).widens).toBe(true);
    expect(compareChildAccess(before, effectiveChildCapabilities("young_child", {})).widens).toBe(
      false,
    );
  });

  it("matches the capability lists in the migration", () => {
    const sql = readFileSync(
      new URL("../../../../supabase/migrations/20261129090000_child_profiles.sql", import.meta.url),
      "utf8",
    );
    const start = sql.indexOf("create function private.child_capabilities()");
    const end = sql.indexOf("create function private.valid_child_overrides");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const lists = sql.slice(start, end);
    for (const capability of childCapabilities) expect(lists).toContain(`'${capability}'`);
    for (const [preset, capabilities] of Object.entries(childPresetCapabilities)) {
      const block = lists.slice(lists.indexOf(`when '${preset}'`));
      const body = block.slice(block.indexOf("array["), block.indexOf("]"));
      expect([...body.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).toSorted()).toEqual(
        [...capabilities].toSorted(),
      );
    }
    const listed = [...lists.matchAll(/'([a-z][A-Za-z]+)'/g)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined && /[A-Z]/.test(name));
    for (const name of new Set(listed)) {
      expect(childCapabilities as readonly string[]).toContain(name);
    }
  });
});

describe("child actions", () => {
  it("gives the primary guardian every guardian action", () => {
    const projection = childPermissions(facts({ guardianRole: "primary" }));
    expect(projection["child.access.change"]).toBe(true);
    expect(projection["child.guardian.assignSecondary"]).toBe(true);
    expect(projection["child.guardian.handOverPrimary"]).toBe(true);
    expect(projection["child.remove"]).toBe(true);
    expect(projection["child.link.issue"]).toBe(true);
    expect(projection["child.guardian.appointPrimary"]).toBe(false);
  });

  it("limits the secondary guardian to routine actions", () => {
    const secondary = facts({ guardianRole: "secondary" });
    expect(decideChildAction(secondary, "child.access.restrict")).toBe(true);
    expect(decideChildAction(secondary, "child.presentation.change")).toBe(true);
    expect(decideChildAction(secondary, "child.guardian.removeSecondary")).toBe(true);
    expect(decideChildAction(secondary, "child.access.change")).toBe(false);
    expect(decideChildAction(secondary, "child.guardian.handOverPrimary")).toBe(false);
    expect(decideChildAction(secondary, "child.guardian.assignSecondary")).toBe(false);
    expect(decideChildAction(secondary, "child.remove")).toBe(false);
    expect(decideChildAction(secondary, "child.link.issue")).toBe(false);
  });

  it("keeps independent sign-in decisions with the primary guardian (S42)", () => {
    const primary = facts({ guardianRole: "primary" });
    const secondary = facts({ guardianRole: "secondary" });
    expect(decideChildAction(primary, "child.signIn.manage")).toBe(true);
    expect(decideChildAction(primary, "child.signIn.assist")).toBe(true);
    expect(decideChildAction(secondary, "child.signIn.manage")).toBe(false);
    expect(decideChildAction(secondary, "child.signIn.assist")).toBe(true);
    for (const homeRole of ["owner", "administrator", "member"] as const) {
      const notGuardian = facts({ homeRole, guardianRole: null });
      expect(decideChildAction(notGuardian, "child.signIn.manage")).toBe(false);
      expect(decideChildAction(notGuardian, "child.signIn.assist")).toBe(false);
    }
  });

  it("gives Home managers no guardian authority", () => {
    for (const homeRole of ["owner", "administrator"] as const) {
      const manager = facts({ homeRole });
      expect(decideChildAction(manager, "child.access.change")).toBe(false);
      expect(decideChildAction(manager, "child.access.restrict")).toBe(false);
      expect(decideChildAction(manager, "child.presentation.change")).toBe(false);
      expect(decideChildAction(manager, "child.guardian.appointPrimary")).toBe(false);
    }
    expect(decideChildAction(facts({ homeRole: "owner" }), "child.remove")).toBe(true);
    expect(decideChildAction(facts({ homeRole: "administrator" }), "child.remove")).toBe(false);
  });

  it("lets only the Owner appoint a primary guardian for a child on hold", () => {
    const onHold = { hasPrimaryGuardian: false } as const;
    expect(
      decideChildAction(facts({ ...onHold, homeRole: "owner" }), "child.guardian.appointPrimary"),
    ).toBe(true);
    expect(
      decideChildAction(
        facts({ ...onHold, homeRole: "administrator" }),
        "child.guardian.appointPrimary",
      ),
    ).toBe(false);
    expect(
      decideChildAction(
        facts({ ...onHold, guardianRole: "secondary" }),
        "child.guardian.appointPrimary",
      ),
    ).toBe(false);
  });

  it("refuses everything to a non-member, even with a stale guardian role", () => {
    const outsider = facts({ homeRole: null, guardianRole: "primary" });
    for (const action of childActions) expect(decideChildAction(outsider, action)).toBe(false);
  });
});
