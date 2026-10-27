import { extractRecipe } from "./extract";
import { startTags, stripTags, tagAttributes } from "./markup";

const TWO_MB = 2 * 1024 * 1024;

function repeated(unit: string, size = TWO_MB): string {
  return unit.repeat(Math.ceil(size / unit.length));
}

/** Milliseconds `run` takes. */
function timed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe("tagAttributes", () => {
  it("reads quoted, unquoted and bare attributes; the first of a name wins", () => {
    const attributes = tagAttributes(` type="application/ld+json" data-x=1 async TYPE='other'`);
    expect([...attributes]).toEqual([
      ["type", "application/ld+json"],
      ["data-x", "1"],
      ["async", ""],
    ]);
  });
});

describe("startTags", () => {
  it("finds each start tag of the name, not of longer names", () => {
    const body = '<scripts></scripts><script type="a">x</script><SCRIPT type=b></SCRIPT>';
    const types = [...startTags(body, body.toLowerCase(), "script")].map((tag) =>
      tag.attributes.get("type"),
    );
    expect(types).toEqual(["a", "b"]);
  });
});

describe("stripTags", () => {
  it.each([
    ["Mix <b>every</b>thing.", "Mix everything."],
    ["One<br>two</p>three", "One\ntwo\nthree"],
    ["a<div>b</div>c", "a b c"],
    ["Soup<script>alert(1)</script>!", "Soup !"],
    ["x<style>p{}</style>y", "x y"],
    ["2 < 3", "2 < 3"],
    ["<script>never closed", " never closed"],
  ])("strips %j", (input, expected) => {
    expect(stripTags(input)).toBe(expected);
  });
});

// A hostile page must not hold the server for longer than reading it takes (review finding B1).
describe("hostile pages of the largest accepted size", () => {
  const bound = 2000;
  it.each([
    ["script openers without a closing >", repeated("<script type=application/ld+json ")],
    [
      "script openers with one > at the very end",
      `${repeated("<script type=application/ld+json ")}>`,
    ],
    ["meta openers without a closing >", repeated('<meta property="og:site_name" ')],
    ["meta tags without content", repeated('<meta property="og:site_name">')],
    ["opening brackets", repeated("<")],
    ["unclosed script tags", repeated("<script>")],
    [
      "a JSON-LD string full of brackets",
      `<script type="application/ld+json">{"@type":"Recipe","name":"${repeated("<", TWO_MB - 100)}"}</script>`,
    ],
    [
      "a JSON-LD string full of unclosed scripts",
      `<script type="application/ld+json">{"@type":"Recipe","description":"${repeated("<style>", TWO_MB - 100)}"}</script>`,
    ],
  ])("reads %s quickly", (_label, body) => {
    expect(timed(() => extractRecipe(body, "https://example.com/r"))).toBeLessThan(bound);
  });

  it.each([
    ["opening brackets", repeated("<")],
    ["brackets before one closing >", `${repeated("<a")}>`],
    ["unclosed scripts", repeated("<script>")],
  ])("strips %s quickly", (_label, text) => {
    expect(timed(() => stripTags(text))).toBeLessThan(bound);
  });
});
