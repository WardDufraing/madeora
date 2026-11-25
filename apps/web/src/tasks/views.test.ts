import { describe, expect, it } from "vitest";

import { daysOverdue, groupQuery, parseTaskView, viewGroups, viewHref } from "./views";

describe("parseTaskView", () => {
  it("starts on Today", () => {
    expect(parseTaskView({})).toBe("today");
    expect(parseTaskView({ deleted: "1" })).toBe("today");
  });

  it("takes an explicit view, and falls back for one it does not know", () => {
    expect(parseTaskView({ view: "upcoming" })).toBe("upcoming");
    expect(parseTaskView({ view: ["all", "lists"] })).toBe("all");
    expect(parseTaskView({ view: "nonsense" })).toBe("today");
  });

  it("keeps old addresses working: a list means Lists, a filter means All", () => {
    expect(parseTaskView({ list: "abc" })).toBe("lists");
    expect(parseTaskView({ status: "all" })).toBe("all");
    expect(parseTaskView({ assignee: "needs_reassignment" })).toBe("all");
    expect(parseTaskView({ list: "abc", status: "all" })).toBe("lists");
  });
});

describe("viewHref", () => {
  it("builds addresses in the right context and keeps the list only for Lists", () => {
    expect(viewHref(null, "today")).toBe("/tasks?view=today");
    expect(viewHref("h1", "lists", { list: "l1" })).toBe("/homes/h1/tasks?view=lists&list=l1");
    expect(viewHref(null, "all", { list: "l1" })).toBe("/tasks?view=all");
    expect(viewHref(null, "all", { task: "t1" })).toBe("/tasks?view=all&task=t1");
  });
});

describe("daysOverdue", () => {
  it("counts whole calendar days and never goes negative", () => {
    expect(daysOverdue("2026-10-14", "2026-10-16")).toBe(2);
    expect(daysOverdue("2026-02-27", "2026-03-02")).toBe(3);
    expect(daysOverdue("2026-10-16", "2026-10-16")).toBe(0);
    expect(daysOverdue("2026-10-20", "2026-10-16")).toBe(0);
  });
});

describe("view groups", () => {
  it("reads open tasks by timing, from every list", () => {
    expect(groupQuery("overdue")).toMatchObject({ status: "open", when: "overdue" });
    expect(groupQuery("overdue").list).toBeUndefined();
    expect(viewGroups.today.map((group) => group.id)).toEqual(["overdue", "today", "undated"]);
    expect(viewGroups.upcoming.map((group) => group.id)).toEqual(["week", "later"]);
  });
});
