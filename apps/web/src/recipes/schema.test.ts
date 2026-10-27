import {
  emptyRecipeForm,
  parseRecipeQuery,
  recipeContentSchema,
  recipeQueryString,
  tagKey,
  toRecipeContent,
} from "./schema";

describe("tag keys", () => {
  it("compare case, accents and compatibility forms alike, as the database does", () => {
    expect(tagKey("Végan")).toBe(tagKey("vegan"));
    expect(tagKey("ＣＡＦＥ")).toBe("cafe");
    expect(tagKey("  quick   meals ")).toBe("quick meals");
  });
});

describe("the editor's content", () => {
  it("drops blank rows and parses typed amounts exactly", () => {
    const result = toRecipeContent(
      {
        ...emptyRecipeForm(),
        name: " Soup ",
        servings: "4",
        ingredients: [
          { name: "Carrots", quantity: "1,5", unit: "kg", note: "" },
          { name: "", quantity: "", unit: "", note: "" },
          { name: "Stock", quantity: "1/3", unit: "l", note: "hot" },
        ],
        steps: [{ text: "" }, { text: "Boil." }],
      },
      true,
    );
    if (!result.ok) throw new Error("expected valid content");
    expect(result.content).toMatchObject({
      name: "Soup",
      servings: 4,
      steps: ["Boil."],
      ingredients: [
        { name: "Carrots", quantity: { num: 3, den: 2, style: "decimal" }, unit: "kg", note: null },
        { name: "Stock", quantity: { num: 1, den: 3, style: "fraction" }, unit: "l", note: "hot" },
      ],
    });
  });

  it("allows an empty draft but not an empty published recipe", () => {
    expect(toRecipeContent(emptyRecipeForm(), false).ok).toBe(true);
    const published = toRecipeContent(emptyRecipeForm(), true);
    expect(published).toEqual({
      ok: false,
      errors: { name: "required", ingredients: "required" },
    });
  });

  it("names the row of a wrong amount, a missing ingredient name and a bad number", () => {
    const result = toRecipeContent(
      {
        ...emptyRecipeForm(),
        prepMinutes: "-5",
        ingredients: [
          { name: "Flour", quantity: "0", unit: "", note: "" },
          { name: "", quantity: "2", unit: "", note: "" },
        ],
      },
      false,
    );
    expect(result).toEqual({
      ok: false,
      errors: {
        "ingredients.0.quantity": "invalidQuantity",
        "ingredients.1.name": "required",
        prepMinutes: "invalidNumber",
      },
    });
  });

  it("refuses the same tag twice in another case or with accents", () => {
    const result = recipeContentSchema.safeParse({
      ...toRecipeContentOrThrow(),
      tags: ["Vegan", "végan"],
    });
    expect(result.success).toBe(false);
  });
});

function toRecipeContentOrThrow() {
  const result = toRecipeContent(emptyRecipeForm(), false);
  if (!result.ok) throw new Error("unexpected");
  return result.content;
}

describe("the library's search parameters", () => {
  it("keeps every selected tag and falls back for anything unknown", () => {
    const query = parseRecipeQuery({
      q: "soep",
      tag: ["Winter", "Vlaams"],
      sort: "nope",
      offset: "-3",
    });
    expect(query).toEqual({
      q: "soep",
      tags: ["Winter", "Vlaams"],
      favorites: false,
      sort: "name_asc",
      offset: 0,
    });
    expect(recipeQueryString(query)).toBe("?q=soep&tag=Winter&tag=Vlaams");
  });
});
