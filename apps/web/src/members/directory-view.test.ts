import {
  arrangeDirectory,
  isCustomized,
  nameCollator,
  parseDirectoryQuery,
  sharedNameIds,
  type DirectoryMember,
} from "./directory-view";

function member(
  id: string,
  role: DirectoryMember["role"],
  name: string | null,
  joinedAt: string,
): DirectoryMember {
  return { membershipId: id, role, name, joinedAt, isSelf: false, accentColor: null };
}

const collator = nameCollator("en");
const members = [
  member("m1", "member", "zoë", "2026-10-03T10:00:00Z"),
  member("m2", "owner", "Bram", "2026-10-01T10:00:00Z"),
  member("m3", "member", null, "2026-10-02T10:00:00Z"),
  member("m4", "administrator", "Alex", "2026-10-04T10:00:00Z"),
  member("m5", "member", "alex", "2026-10-05T10:00:00Z"),
];
const zoe = members[0] as DirectoryMember;
const ids = (list: readonly DirectoryMember[]) => list.map((m) => m.membershipId);

describe("parseDirectoryQuery", () => {
  it("defaults to role order with no filter", () => {
    const query = parseDirectoryQuery({});
    expect(query.sort).toBe("role");
    expect(query.roles.size).toBe(0);
    expect(isCustomized(query)).toBe(false);
  });

  it("reads a sort and several roles, ignoring anything unknown", () => {
    const query = parseDirectoryQuery({ sort: "name", role: ["member", "boss", "owner"] });
    expect(query.sort).toBe("name");
    expect([...query.roles].sort()).toEqual(["member", "owner"]);
    expect(isCustomized(query)).toBe(true);
    expect(parseDirectoryQuery({ sort: "shoe-size" }).sort).toBe("role");
  });

  it("treats every role selected as no filter", () => {
    const query = parseDirectoryQuery({ role: ["owner", "administrator", "member"] });
    expect(query.roles.size).toBe(0);
  });
});

describe("arrangeDirectory", () => {
  it("orders by role, then name (people without a name last), then joining date", () => {
    expect(ids(arrangeDirectory(members, parseDirectoryQuery({}), collator))).toEqual([
      "m2",
      "m4",
      "m5",
      "m1",
      "m3",
    ]);
  });

  it("sorts by name, keeping people without a name last", () => {
    expect(ids(arrangeDirectory(members, parseDirectoryQuery({ sort: "name" }), collator))).toEqual(
      ["m4", "m5", "m2", "m1", "m3"],
    );
  });

  it("sorts by joining date, oldest first", () => {
    expect(
      ids(arrangeDirectory(members, parseDirectoryQuery({ sort: "joined" }), collator)),
    ).toEqual(["m2", "m3", "m1", "m4", "m5"]);
  });

  it("filters by one or more roles and can come back empty", () => {
    expect(
      ids(arrangeDirectory(members, parseDirectoryQuery({ role: "administrator" }), collator)),
    ).toEqual(["m4"]);
    expect(
      ids(arrangeDirectory(members, parseDirectoryQuery({ role: ["owner", "member"] }), collator)),
    ).toEqual(["m2", "m5", "m1", "m3"]);
    expect(arrangeDirectory([zoe], parseDirectoryQuery({ role: "owner" }), collator)).toEqual([]);
  });

  it("does not change the list it was given", () => {
    const copy = [...members];
    arrangeDirectory(members, parseDirectoryQuery({ sort: "name" }), collator);
    expect(members).toEqual(copy);
  });
});

describe("sharedNameIds", () => {
  it("finds names that differ only in case or accents", () => {
    const shared = sharedNameIds(members, collator);
    expect([...shared].sort()).toEqual(["m4", "m5"]);
  });

  it("marks several people without a name, and nobody in a Home of one", () => {
    const nameless = [
      member("a", "owner", null, "2026-10-01T10:00:00Z"),
      member("b", "member", null, "2026-10-02T10:00:00Z"),
    ];
    expect([...sharedNameIds(nameless, collator)].sort()).toEqual(["a", "b"]);
    expect(sharedNameIds([zoe], collator).size).toBe(0);
  });

  it("treats names with accents as the same as without (Zoë and Zoe)", () => {
    const list = [
      member("a", "owner", "Zoë", "2026-10-01T10:00:00Z"),
      member("b", "member", "Zoe", "2026-10-02T10:00:00Z"),
    ];
    expect(sharedNameIds(list, collator).size).toBe(2);
  });
});
