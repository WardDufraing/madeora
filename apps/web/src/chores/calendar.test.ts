import type { ChoreAgendaItem } from "./api";
import {
  byDate,
  choreCalendarQueryString,
  filterAgenda,
  isMovable,
  itemStates,
  parseChoreCalendarQuery,
} from "./calendar";

const MEMBER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";
const OTHER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0041";
const CATEGORY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0070";

function item(extra: Partial<ChoreAgendaItem> = {}): ChoreAgendaItem {
  return {
    id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020",
    choreId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021",
    title: "Dishes",
    date: "2026-10-21",
    category: null,
    status: "open",
    overdue: false,
    inRework: false,
    needsReassignment: false,
    awaitingVolunteer: false,
    assigneeIds: [MEMBER],
    minutes: null,
    revision: 1,
    recurring: false,
    projected: false,
    ...extra,
  };
}

describe("the Chores calendar address", () => {
  it("keeps what it understands and drops the rest", () => {
    expect(
      parseChoreCalendarQuery({
        view: "month",
        date: "2026-10-01",
        day: "2026-10-21",
        member: MEMBER,
        category: "none",
      }),
    ).toEqual({
      view: "month",
      date: "2026-10-01",
      day: "2026-10-21",
      member: MEMBER,
      category: "none",
    });
    expect(
      parseChoreCalendarQuery({
        view: "year",
        date: "2026-13-01",
        day: ["x", "2026-10-21"],
        member: "Bea",
        category: "<script>",
      }),
    ).toEqual({ view: "week", date: null, day: null, member: null, category: null });
    expect(parseChoreCalendarQuery({ member: "unassigned" }).member).toBe("unassigned");
  });

  it("leaves defaults out of the address and applies changes", () => {
    const query = parseChoreCalendarQuery({ date: "2026-10-19", member: MEMBER });
    expect(choreCalendarQueryString(query)).toBe(`date=2026-10-19&member=${MEMBER}`);
    expect(
      choreCalendarQueryString(query, { view: "month", member: null, day: "2026-10-21" }),
    ).toBe("view=month&date=2026-10-19&day=2026-10-21");
  });
});

describe("filtering a schedule", () => {
  const items = [
    item({ title: "Mine" }),
    item({ title: "Theirs", assigneeIds: [OTHER] }),
    item({ title: "Nobody", assigneeIds: [] }),
    item({ title: "Tidy", category: { id: CATEGORY, name: "Tidy", color: null } }),
  ];
  const titles = (list: readonly ChoreAgendaItem[]) => list.map((entry) => entry.title);

  it("by member, unassigned and category", () => {
    expect(titles(filterAgenda(items, { member: null, category: null }))).toHaveLength(4);
    expect(titles(filterAgenda(items, { member: MEMBER, category: null }))).toEqual([
      "Mine",
      "Tidy",
    ]);
    expect(titles(filterAgenda(items, { member: "unassigned", category: null }))).toEqual([
      "Nobody",
    ]);
    expect(titles(filterAgenda(items, { member: null, category: CATEGORY }))).toEqual(["Tidy"]);
    expect(titles(filterAgenda(items, { member: null, category: "none" }))).toEqual([
      "Mine",
      "Theirs",
      "Nobody",
    ]);
  });

  it("groups by date in the order given", () => {
    const grouped = byDate([
      item({ title: "A" }),
      item({ title: "B", date: "2026-10-22" }),
      item({ title: "C" }),
    ]);
    expect(titles(grouped.get("2026-10-21") ?? [])).toEqual(["A", "C"]);
    expect(titles(grouped.get("2026-10-22") ?? [])).toEqual(["B"]);
  });
});

describe("moving and states", () => {
  it("moves only an existing open occurrence outside rework", () => {
    expect(isMovable(item())).toBe(true);
    expect(isMovable(item({ projected: true, id: null, revision: null }))).toBe(false);
    expect(isMovable(item({ status: "pending_approval" }))).toBe(false);
    expect(isMovable(item({ status: "completed" }))).toBe(false);
    expect(isMovable(item({ inRework: true }))).toBe(false);
  });

  it("names every state in words", () => {
    expect(itemStates(item())).toEqual([]);
    expect(itemStates(item({ projected: true }))).toEqual(["planned"]);
    expect(itemStates(item({ status: "pending_approval" }))).toEqual(["pending"]);
    expect(itemStates(item({ inRework: true, overdue: true }))).toEqual(["rework", "overdue"]);
    expect(itemStates(item({ status: "skipped" }))).toEqual(["skipped"]);
    expect(itemStates(item({ status: "expired" }))).toEqual(["expired"]);
    expect(itemStates(item({ awaitingVolunteer: true, assigneeIds: [] }))).toEqual(["awaiting"]);
    expect(itemStates(item({ needsReassignment: true, assigneeIds: [] }))).toEqual(["review"]);
    expect(itemStates(item({ needsReassignment: true }))).toEqual([]);
  });
});
