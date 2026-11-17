import { actionInputSchema, isOraActionId, isTaskEditAction } from "./types";

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

  it("accepts the task steps of the two task edits (S47d)", () => {
    for (const input of [
      { step: "task", id: ID },
      { step: "undo-completion", id: ID, completedAt: "2026-11-15T10:00:00.123456+00:00" },
      { step: "undo-due", id: ID, expectedRevision: 3, previousDue: "2026-12-01" },
      { step: "undo-due", id: ID, expectedRevision: 3, previousDue: null },
    ]) {
      expect(actionInputSchema.safeParse(input).success).toBe(true);
    }
  });

  it("refuses malformed task steps (S47d)", () => {
    for (const input of [
      { step: "task" },
      { step: "task", id: ID, extra: 1 },
      { step: "undo-completion", id: ID, completedAt: "yesterday" },
      { step: "undo-completion", id: ID },
      { step: "undo-due", id: ID, expectedRevision: 3 },
      { step: "undo-due", id: ID, expectedRevision: 3, previousDue: "01-12-2026" },
      { step: "undo-due", id: ID, expectedRevision: 0, previousDue: null },
    ]) {
      expect(actionInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("tells the task edits from the additions (S47d)", () => {
    expect(isOraActionId("complete-task")).toBe(true);
    expect(isOraActionId("change-task-due")).toBe(true);
    expect(isTaskEditAction("complete-task")).toBe(true);
    expect(isTaskEditAction("add-task")).toBe(false);
  });

  it("knows only its own actions", () => {
    expect(isOraActionId("add-task")).toBe(true);
    expect(isOraActionId("delete-everything")).toBe(false);
  });
});
