import { initials } from "./initials";

describe("initials", () => {
  it.each([
    ["Alice", "A"],
    ["alice van dam", "AD"],
    ["Émile Zola", "ÉZ"],
    ["(Bram)", "B"],
    ["李小龍", "李"],
    ["Sam \u{1F31F}", "S\u{1F31F}"],
    ["\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}", "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"],
    ["?!", "?"],
  ])("%j gives %j", (name, expected) => {
    expect(initials(name, "en")).toBe(expected);
  });

  it("has nothing for no name", () => {
    expect(initials(null, "en")).toBeNull();
  });

  it("upper-cases with the locale's rules", () => {
    expect(initials("ilk", "tr")).toBe("\u{130}");
  });
});
