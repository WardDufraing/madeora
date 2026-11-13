import { actionInputSchema, isOraActionId } from "./types";

const ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00aa";

describe("guided change input", () => {
  it("accepts a prepare step and an undo step", () => {
    expect(actionInputSchema.safeParse({ step: "prepare" }).success).toBe(true);
    expect(actionInputSchema.safeParse({ step: "undo", id: ID, expectedRevision: 2 }).success).toBe(
      true,
    );
  });

  it("refuses anything else: unknown steps, extra fields, bad ids and revisions", () => {
    for (const input of [
      {},
      { step: "apply" },
      { step: "prepare", extra: true },
      { step: "undo", id: "nope", expectedRevision: 1 },
      { step: "undo", id: ID, expectedRevision: 0 },
      { step: "undo", id: ID },
      { step: "undo", id: ID, expectedRevision: 1.5 },
    ]) {
      expect(actionInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("knows only its own actions", () => {
    expect(isOraActionId("add-task")).toBe(true);
    expect(isOraActionId("delete-everything")).toBe(false);
  });
});
