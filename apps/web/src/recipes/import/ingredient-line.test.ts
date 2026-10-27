import { parseIngredientLine } from "./ingredient-line";

describe("parseIngredientLine", () => {
  it.each([
    ["200 g flour", { name: "flour", quantity: "200", unit: "g" }],
    ["2 1/2 cups of milk", { name: "milk", quantity: "2 1/2", unit: "cup" }],
    ["1/2 tsp. salt", { name: "salt", quantity: "1/2", unit: "tsp" }],
    ["1,5 l water", { name: "water", quantity: "1,5", unit: "l" }],
    ["0.25 kg butter", { name: "butter", quantity: "0.25", unit: "kg" }],
    ["2 eetlepels suiker", { name: "suiker", quantity: "2", unit: "tbsp" }],
    ["1 blik van 400 g tomaten", { name: "400 g tomaten", quantity: "1", unit: "can" }],
    ["3 teentjes knoflook", { name: "knoflook", quantity: "3", unit: "clove" }],
    ["2 fl oz cream", { name: "cream", quantity: "2", unit: "fl_oz" }],
    ["1½ cups sugar", { name: "sugar", quantity: "1 ½", unit: "cup" }],
    ["½ lemon", { name: "lemon", quantity: "½", unit: null }],
    ["3 eggs", { name: "eggs", quantity: "3", unit: null }],
    ["2 garlic cloves", { name: "garlic cloves", quantity: "2", unit: null }],
    ["1 gigantic pumpkin", { name: "gigantic pumpkin", quantity: "1", unit: null }],
    ["200g flour", { name: "flour", quantity: "200", unit: "g" }],
    ["- 100 ml oil", { name: "oil", quantity: "100", unit: "ml" }],
  ])("reads %j", (line, expected) => {
    expect(parseIngredientLine(line)).toEqual({ ...expected, asWritten: false });
  });

  it.each(["salt and pepper", "Fresh basil, to taste"])(
    "keeps %j as a name without a quantity",
    (line) => {
      expect(parseIngredientLine(line)).toEqual({
        name: line,
        quantity: "",
        unit: null,
        asWritten: false,
      });
    },
  );

  it.each([
    "2-3 eggs",
    "2 – 3 eggs",
    "2 to 3 tomatoes",
    "1 of 2 uien",
    "1.000 g bloem",
    "1,500 ml water",
    "2x flour",
    "200 g",
    "0 eggs",
  ])("keeps %j as written, without guessing", (line) => {
    expect(parseIngredientLine(line)).toEqual({
      name: line,
      quantity: "",
      unit: null,
      asWritten: true,
    });
  });
});
