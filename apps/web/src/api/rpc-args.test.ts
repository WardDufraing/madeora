import { nullableArg } from "./rpc-args";

describe("nullableArg", () => {
  it("passes a value and null through unchanged", () => {
    expect(nullableArg("09:00")).toBe("09:00");
    expect(nullableArg(null)).toBeNull();
  });
});
