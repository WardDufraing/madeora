import { formatRememberedContext, parseRememberedContext } from "./context-cookie";

const USER = "10000000-0000-4000-8000-000000000001";
const OTHER_USER = "10000000-0000-4000-8000-000000000002";
const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";

describe("remembered context cookie", () => {
  it("round-trips Personal and a Home for the same account", () => {
    for (const context of [{ kind: "personal" }, { kind: "home", homeId: HOME }] as const) {
      expect(parseRememberedContext(formatRememberedContext(USER, context), USER)).toEqual(context);
    }
  });

  it("ignores a value left by another account on this device", () => {
    const value = formatRememberedContext(OTHER_USER, { kind: "home", homeId: HOME });
    expect(parseRememberedContext(value, USER)).toBeNull();
  });

  it.each([undefined, "", USER, `${USER}.`, `${USER}.not-a-uuid`, `${USER}.${HOME}.x`, `.${HOME}`])(
    "ignores %j",
    (value) => {
      expect(parseRememberedContext(value, USER)).toBeNull();
    },
  );
});
