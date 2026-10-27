import { durationMinutes, extractRecipe } from "./extract";

const URL_ = "https://www.example.com/pancakes";

function pageWith(data: unknown, head = ""): string {
  return `<html><head>${head}<script type="application/ld+json">${JSON.stringify(data).replaceAll("</", "<\\/")}</script></head><body></body></html>`;
}

const recipe = {
  "@context": "https://schema.org",
  "@type": "Recipe",
  name: "Pancakes",
  author: { "@type": "Person", name: "Sam Baker" },
  publisher: { "@type": "Organization", name: "Example Kitchen" },
  description: "Fluffy &amp; quick.",
  recipeYield: "4 servings",
  prepTime: "PT10M",
  cookTime: "PT1H5M",
  keywords: "breakfast, sweet, Breakfast",
  recipeCategory: "Brunch",
  recipeIngredient: ["200 g flour", "2-3 eggs", "300 ml milk"],
  recipeInstructions: [
    { "@type": "HowToStep", text: "Mix <b>everything</b>." },
    { "@type": "HowToSection", itemListElement: [{ "@type": "HowToStep", text: "Bake." }] },
  ],
  image: "https://www.example.com/pancakes.jpg",
};

describe("extractRecipe", () => {
  it("reads a schema.org Recipe into an editable preview, flagging what needs review", () => {
    const result = extractRecipe(pageWith(recipe), URL_);
    expect(result).toEqual({
      ok: true,
      preview: {
        source: { url: URL_, name: "Example Kitchen · Sam Baker" },
        name: "Pancakes",
        servings: 4,
        servingsLabel: null,
        prepMinutes: 10,
        cookMinutes: 65,
        notes: "Fluffy & quick.",
        tags: ["breakfast", "sweet", "Brunch"],
        ingredients: [
          { name: "flour", quantity: "200", unit: "g", asWritten: false },
          { name: "2-3 eggs", quantity: "", unit: null, asWritten: true },
          { name: "milk", quantity: "300", unit: "ml", asWritten: false },
        ],
        steps: ["Mix everything.", "Bake."],
        warnings: expect.arrayContaining(["ingredientsAsWritten", "photoNotCopied"]) as unknown,
      },
    });
    if (result.ok) expect(result.preview.warnings).toHaveLength(2);
  });

  it("finds the recipe inside @graph and among other blocks", () => {
    const body =
      pageWith({ "@type": "WebSite", name: "Site" }) +
      pageWith({
        "@context": "https://schema.org",
        "@graph": [{ "@type": "Article" }, { ...recipe, "@type": ["Recipe"] }],
      });
    const result = extractRecipe(body, URL_);
    expect(result.ok && result.preview.name).toBe("Pancakes");
  });

  it("states nothing the page did not: missing parts are warnings, not guesses", () => {
    const result = extractRecipe(pageWith({ "@type": "Recipe" }), URL_);
    expect(result).toEqual({
      ok: true,
      preview: expect.objectContaining({
        name: null,
        servings: null,
        prepMinutes: null,
        cookMinutes: null,
        ingredients: [],
        steps: [],
        source: { url: URL_, name: "example.com" },
        warnings: expect.arrayContaining([
          "noName",
          "noIngredients",
          "noSteps",
          "noServings",
        ]) as unknown,
      }) as unknown,
    });
  });

  it("uses the site name from og:site_name when there is no publisher", () => {
    const { publisher: _publisher, author: _author, ...rest } = recipe;
    const head = '<meta property="og:site_name" content="Kitchen Site">';
    const result = extractRecipe(pageWith(rest, head), URL_);
    expect(result.ok && result.preview.source.name).toBe("Kitchen Site");
  });

  it.each([
    ["2-4", "ambiguousServings"],
    ["0", "ambiguousServings"],
    ["serves 6 to 8", "ambiguousServings"],
  ])("does not guess servings from %j", (recipeYield, warning) => {
    const result = extractRecipe(pageWith({ ...recipe, recipeYield }), URL_);
    expect(result.ok && result.preview.servings).toBeNull();
    expect(result.ok && result.preview.warnings).toContain(warning);
  });

  it("keeps a yield word that says what the servings are", () => {
    const result = extractRecipe(pageWith({ ...recipe, recipeYield: ["12 cookies"] }), URL_);
    expect(result.ok && [result.preview.servings, result.preview.servingsLabel]).toEqual([
      12,
      "cookies",
    ]);
  });

  it("shortens over-long text and drops items past the limits, with warnings", () => {
    const result = extractRecipe(
      pageWith({
        ...recipe,
        name: "x".repeat(1000),
        recipeIngredient: Array.from({ length: 500 }, (_, i) => `${String(i + 1)} g flour`),
      }),
      URL_,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.preview.name ?? "").length).toBeLessThan(1000);
    expect(result.preview.ingredients.length).toBeLessThan(500);
    expect(result.preview.warnings).toEqual(
      expect.arrayContaining(["textShortened", "tooManyItems"]),
    );
  });

  it("refuses a time it cannot store", () => {
    const result = extractRecipe(pageWith({ ...recipe, cookTime: "P30D" }), URL_);
    expect(result.ok && result.preview.cookMinutes).toBeNull();
    expect(result.ok && result.preview.warnings).toContain("timeOutOfRange");
  });

  it("never carries markup or scripts into the preview", () => {
    const result = extractRecipe(
      pageWith({ ...recipe, name: '<img src=x onerror="alert(1)">Soup<script>alert(1)</script>' }),
      URL_,
    );
    expect(result.ok && result.preview.name).toBe("Soup");
  });

  it.each([
    ["no JSON-LD", "<html><body><h1>Pancakes</h1></body></html>"],
    ["broken JSON-LD", '<script type="application/ld+json">{"@type": "Recipe",</script>'],
    ["no Recipe node", pageWith({ "@type": "Article", name: "News" })],
  ])("says there is no recipe on a page with %s", (_label, body) => {
    expect(extractRecipe(body, URL_)).toEqual({ ok: false });
  });
});

describe("durationMinutes", () => {
  it.each([
    ["PT45M", 45],
    ["PT1H30M", 90],
    ["P0DT2H", 120],
    ["PT90M", 90],
    ["P1D", 1440],
    ["PT30S", 1],
  ])("reads %s", (value, minutes) => {
    expect(durationMinutes(value)).toBe(minutes);
  });

  it.each(["P", "PT", "45 minutes", "", "PT-5M"])("refuses %j", (value) => {
    expect(durationMinutes(value)).toBeNull();
  });

  it("refuses a value that is not text", () => {
    expect(durationMinutes(45)).toBeNull();
  });
});
