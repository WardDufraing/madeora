import { safeNextPath, signInPath } from "./redirects";

describe("safeNextPath", () => {
  it.each([
    ["/", "/"],
    ["/tasks", "/tasks"],
    ["/tasks?filter=open#today", "/tasks?filter=open#today"],
    ["/settings/../tasks", "/tasks"],
  ])("keeps the same-site path %s", (value, expected) => {
    expect(safeNextPath(value)).toBe(expected);
  });

  it.each([
    [undefined],
    [null],
    [""],
    ["tasks"],
    ["https://evil.example/"],
    ["//evil.example"],
    ["/\\evil.example"],
    ["/\t/evil.example"],
    ["/\n/evil.example"],
    ["/tasks\\..\\..\\evil"],
    ["javascript:alert(1)"],
    [`/${"a".repeat(2048)}`],
  ])("falls back to the dashboard for %j", (value) => {
    expect(safeNextPath(value)).toBe("/");
  });
});

describe("signInPath", () => {
  it("asks to come back to the requested page", () => {
    expect(signInPath("/settings?tab=1")).toBe("/sign-in?next=%2Fsettings%3Ftab%3D1");
  });

  it("leaves out the dashboard and unsafe destinations", () => {
    expect(signInPath("/")).toBe("/sign-in");
    expect(signInPath("//evil.example")).toBe("/sign-in");
    expect(signInPath(null)).toBe("/sign-in");
  });
});
