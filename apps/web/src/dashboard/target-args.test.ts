import { targetArgs, targetFromParams, targetQuery } from "./target-args";

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const isUuid = (value: string) => /^[0-9a-f-]{36}$/.test(value);

describe("targetArgs", () => {
  it("keeps the arguments the personal and shared dashboards always had", () => {
    expect(targetArgs({ kind: "personal" })).toEqual({});
    expect(targetArgs({ kind: "home", homeId: HOME })).toEqual({ p_home_id: HOME });
    expect(targetArgs({ kind: "home", homeId: HOME, view: "default" })).toEqual({
      p_home_id: HOME,
    });
  });

  it("names the target only for the person's own Home view", () => {
    expect(targetArgs({ kind: "home", homeId: HOME, view: "mine" })).toEqual({
      p_home_id: HOME,
      p_target: "mine",
    });
  });
});

describe("targetQuery and targetFromParams", () => {
  it("round-trips every target", () => {
    for (const target of [
      { kind: "personal" },
      { kind: "home", homeId: HOME },
      { kind: "home", homeId: HOME, view: "mine" },
    ] as const) {
      const params = new URLSearchParams(targetQuery(target).replace(/^\?/, ""));
      expect(targetFromParams(params, isUuid)).toEqual(target);
    }
  });

  it("refuses a malformed Home, an unknown view and a view without a Home", () => {
    expect(targetFromParams(new URLSearchParams({ homeId: "nope" }), isUuid)).toBeNull();
    expect(targetFromParams(new URLSearchParams({ homeId: HOME, view: "all" }), isUuid)).toBeNull();
    expect(targetFromParams(new URLSearchParams({ view: "mine" }), isUuid)).toBeNull();
  });
});
