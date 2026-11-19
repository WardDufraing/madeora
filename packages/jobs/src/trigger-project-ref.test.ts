import { describe, expect, it } from "vitest";

import { resolveTriggerProjectRef } from "./trigger-project-ref.ts";

/** Production Trigger.dev project. Other refs in this file are fixtures, not deployed projects. */
const PRODUCTION_REF = "proj_yhkmlscenxkikqvgfnvs";

describe("resolveTriggerProjectRef", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace", " "],
    ["whitespace", "\t\n"],
    ["whitespace", " \t "],
  ] as const)(
    "uses the production project when TRIGGER_PROJECT_REF is %s (%j)",
    (_label, value) => {
      expect(resolveTriggerProjectRef(value)).toBe(PRODUCTION_REF);
    },
  );

  it("uses a set project ref", () => {
    expect(resolveTriggerProjectRef("proj_unittestdummy1")).toBe("proj_unittestdummy1");
  });

  it("trims a set project ref before accepting it", () => {
    expect(resolveTriggerProjectRef("  proj_unittestdummy1  ")).toBe("proj_unittestdummy1");
  });

  it.each(["not-a-ref", "proj_short", "proj_HASUPPER1"])("rejects %j", (value) => {
    expect(() => resolveTriggerProjectRef(value)).toThrow(/TRIGGER_PROJECT_REF/);
  });
});
