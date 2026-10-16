import { defaultTaskQuery, hasTaskFilters, parseTaskQuery, taskQueryString } from "./filters";
import { taskQuerySchema } from "./schema";

const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";
const MEMBER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";
const LABEL = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0050";

describe("parseTaskQuery", () => {
  it("defaults to open tasks by due date with future-start tasks hidden", () => {
    expect(parseTaskQuery({})).toEqual(defaultTaskQuery);
    expect(defaultTaskQuery).toMatchObject({
      status: "open",
      when: "any",
      hideFuture: "1",
      sort: "due",
      priority: [],
      label: [],
    });
    expect(hasTaskFilters(defaultTaskQuery)).toBe(false);
  });

  it("reads the hidden 0 and the ticked 1 of the hide-future box", () => {
    expect(parseTaskQuery({ hideFuture: ["0", "1"] }).hideFuture).toBe("1");
    expect(parseTaskQuery({ hideFuture: "0" }).hideFuture).toBe("0");
  });

  it("turns a member id in assignee into the member filter", () => {
    expect(parseTaskQuery({ assignee: MEMBER })).toMatchObject({
      assignee: "member",
      member: MEMBER,
    });
  });

  it("keeps several priorities and labels", () => {
    const query = parseTaskQuery({ priority: ["high", "unset"], label: LABEL, list: LIST });
    expect(query.priority).toEqual(["high", "unset"]);
    expect(query.label).toEqual([LABEL]);
    expect(hasTaskFilters(query)).toBe(true);
  });

  it("drops values it does not understand instead of failing", () => {
    const query = parseTaskQuery({ when: "someday", status: "completed", label: "not-an-id" });
    expect(query.when).toBe("any");
    expect(query.status).toBe("completed");
    expect(query.label).toEqual([]);
  });

  it("never takes an offset from the page address", () => {
    expect(parseTaskQuery({ offset: "500" }).offset).toBe(0);
  });
});

describe("taskQueryString", () => {
  it("round-trips through the listing schema", () => {
    const query = parseTaskQuery({ list: LIST, priority: ["low"], label: [LABEL], assignee: "me" });
    const params = new URLSearchParams(taskQueryString(query));
    const back = taskQuerySchema.parse({
      ...Object.fromEntries(params),
      priority: params.getAll("priority"),
      label: params.getAll("label"),
    });
    expect(back).toEqual(query);
  });
});

describe("taskQuerySchema", () => {
  it("refuses a page past the offset limit", () => {
    expect(taskQuerySchema.safeParse({ offset: "10001" }).success).toBe(false);
  });
});
