import "server-only";

import { RECIPE_LIMITS } from "@madeora/domain/recipes";

import type { RecipeImportPreview, RecipeImportWarning } from "../api";
import { RECIPE_FIELD_LIMITS, tagKey } from "../schema";
import { parseIngredientLine } from "./ingredient-line";
import { startTags, stripTags } from "./markup";

/**
 * Reads a schema.org `Recipe` from a fetched page's JSON-LD (S25, ARCH §38). The page is untrusted
 * data: only JSON-LD is read (never scripts, styles or other markup), every text loses its tags,
 * entities and invisible characters and is cut to the field limits, and nothing is invented. A
 * field the page does not state stays empty and is reported as missing; a line that cannot be read
 * with confidence is kept as written and reported. Photos are never copied: the preview only says
 * that the page lists one.
 */

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type JsonObject = { readonly [key: string]: Json };

const MAX_SCRIPT_CHARS = 1024 * 1024;
const MAX_SCRIPTS = 20;
const MAX_DEPTH = 8;

const entities: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  deg: "°",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  eacute: "é",
  egrave: "è",
  euml: "ë",
  iuml: "ï",
  ouml: "ö",
  uuml: "ü",
  auml: "ä",
  ccedil: "ç",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/giu, (whole, code: string) => {
    if (code.startsWith("#")) {
      const value =
        code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isInteger(value) &&
        value > 0 &&
        value <= 0x10ffff &&
        !(value >= 0xd800 && value <= 0xdfff)
        ? String.fromCodePoint(value)
        : "";
    }
    return entities[code.toLowerCase()] ?? whole;
  });
}

/**
 * A text as Madeora stores it: no tags, decoded entities, no control or invisible formatting
 * characters (joiners stay), NFC, whitespace collapsed (line breaks kept only when `multiline`).
 */
function cleanText(value: string, multiline = false): string {
  // Twice: entity-encoded markup ("&lt;b&gt;") is markup too once decoded.
  let text = decodeEntities(stripTags(value));
  text = stripTags(decodeEntities(stripTags(text)));
  text = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
    character === "\n" || character === "‌" || character === "‍"
      ? character
      : character === " " || character === " "
        ? "\n"
        : character === "\t"
          ? " "
          : "",
  );
  text = text.normalize("NFC");
  if (!multiline) return text.replace(/\s+/gu, " ").trim();
  return text
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/gu, " ").trim())
    .filter((line, index, lines) => line !== "" || (index > 0 && lines[index - 1] !== ""))
    .join("\n")
    .trim();
}

/** At most `max` characters (code points); `cut` records that something was shortened. */
function limit(text: string, max: number, cut: { shortened: boolean }): string {
  const characters = Array.from(text);
  if (characters.length <= max) return text;
  cut.shortened = true;
  return characters.slice(0, max).join("").trim();
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonArray(value: Json | undefined): value is readonly Json[] {
  return Array.isArray(value);
}

function asArray(value: Json | undefined): readonly Json[] {
  if (value === undefined || value === null) return [];
  return isJsonArray(value) ? value : [value];
}

function isRecipe(node: JsonObject): boolean {
  return asArray(node["@type"]).some(
    (type) =>
      typeof type === "string" && /^(?:https?:\/\/schema\.org\/|schema:)?Recipe$/u.test(type),
  );
}

/** The first Recipe node in a JSON-LD document: top level, arrays, @graph, mainEntity. */
function findRecipe(value: Json | undefined, depth = 0): JsonObject | null {
  if (depth > MAX_DEPTH || value === undefined || value === null) return null;
  if (isJsonArray(value)) {
    for (const item of value) {
      const found = findRecipe(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isObject(value)) return null;
  if (isRecipe(value)) return value;
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"]) {
    const found = findRecipe(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

/** The JSON-LD blocks of a page (or the page itself when it is JSON-LD), parsed; broken ones skipped. */
function jsonLdBlocks(body: string): Json[] {
  const blocks: Json[] = [];
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      blocks.push(JSON.parse(trimmed) as Json);
    } catch {
      // Not JSON after all: read it as a page.
    }
  }
  // Found without regular expressions over the page (./markup.ts): linear in its size.
  const lower = body.toLowerCase();
  const scripts = startTags(body, lower, "script");
  let tag = scripts.next();
  while (!tag.done && blocks.length < MAX_SCRIPTS) {
    const closer = lower.indexOf("</script", tag.value.end);
    if (closer === -1) break;
    const type = (tag.value.attributes.get("type") ?? "").trim().toLowerCase();
    const content = body.slice(tag.value.end, closer);
    if (type === "application/ld+json" && content.length <= MAX_SCRIPT_CHARS) {
      try {
        blocks.push(JSON.parse(content.trim().replace(/^<!--|-->$/gu, "")) as Json);
      } catch {
        // A broken block is skipped; another may hold the recipe.
      }
    }
    // Whatever a script holds is never read as tags: continue after its closing tag.
    tag = scripts.next(closer);
  }
  return blocks;
}

function firstText(value: Json | undefined): string | null {
  for (const item of asArray(value)) {
    if (typeof item === "string" || typeof item === "number") {
      const text = cleanText(String(item));
      if (text !== "") return text;
    }
    if (isObject(item)) {
      const named = firstText(item.name);
      if (named) return named;
    }
  }
  return null;
}

/** Steps from a string, a list of strings, HowToStep (text or name) and HowToSection (nested). */
function steps(value: Json | undefined, depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  const out: string[] = [];
  for (const item of asArray(value)) {
    if (typeof item === "string") {
      const text = cleanText(item, true);
      // A single block of text with line breaks is one step per line.
      out.push(
        ...text
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== ""),
      );
    } else if (isObject(item)) {
      if (item.itemListElement !== undefined) {
        out.push(...steps(item.itemListElement, depth + 1));
      } else {
        const text =
          typeof item.text === "string"
            ? item.text
            : typeof item.name === "string"
              ? item.name
              : "";
        const cleaned = cleanText(text, true);
        if (cleaned !== "") out.push(cleaned);
      }
    }
  }
  return out;
}

/** Whole minutes of an ISO 8601 duration (PT1H30M, P0DT45M, PT90M), or null. */
export function durationMinutes(value: Json | undefined): number | null {
  if (typeof value !== "string") return null;
  const match =
    /^P(?:(\d{1,3})D)?(?:T(?:(\d{1,4})H)?(?:(\d{1,5})M)?(?:(\d{1,6}(?:\.\d+)?)S)?)?$/iu.exec(
      value.trim(),
    );
  if (!match || value.trim().toUpperCase() === "P" || value.trim().toUpperCase() === "PT")
    return null;
  const minutes =
    Number(match[1] ?? 0) * 1440 +
    Number(match[2] ?? 0) * 60 +
    Number(match[3] ?? 0) +
    Math.round(Number(match[4] ?? 0) / 60);
  return Number.isFinite(minutes) ? minutes : null;
}

const genericYieldWords =
  /^(?:servings?|serves|portions?|people|persons?|personen|persoon|porties?|pers\.?)$/iu;

/** Servings and their label from recipeYield ("4", "4 servings", "12 cookies"); a range is not guessed. */
function servingsOf(value: Json | undefined, warnings: Set<RecipeImportWarning>) {
  for (const item of asArray(value)) {
    const text =
      typeof item === "number" ? String(item) : typeof item === "string" ? cleanText(item) : "";
    if (text === "") continue;
    if (/\d\s*(?:-|–|to|tot)\s*\d/iu.test(text)) {
      warnings.add("ambiguousServings");
      return { servings: null, label: null };
    }
    const match = /^(?:serves\s+|voor\s+)?(\d{1,4})\s*(.*)$/iu.exec(text);
    if (!match) continue;
    const servings = Number(match[1]);
    if (servings < RECIPE_LIMITS.minServings || servings > RECIPE_LIMITS.maxServings) {
      warnings.add("ambiguousServings");
      return { servings: null, label: null };
    }
    const rest = (match[2] ?? "").trim();
    const label =
      rest === "" ||
      genericYieldWords.test(rest) ||
      Array.from(rest).length > RECIPE_FIELD_LIMITS.servingsLabel
        ? null
        : rest;
    return { servings, label };
  }
  return { servings: null, label: null };
}

function tags(node: JsonObject): string[] {
  const words: string[] = [];
  for (const key of ["keywords", "recipeCategory", "recipeCuisine"]) {
    for (const item of asArray(node[key])) {
      if (typeof item !== "string") continue;
      words.push(...item.split(","));
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of words) {
    const tag = cleanText(word);
    const key = tagKey(tag);
    if (
      tag === "" ||
      key === "" ||
      seen.has(key) ||
      Array.from(tag).length > RECIPE_FIELD_LIMITS.tag
    )
      continue;
    seen.add(key);
    out.push(tag);
    if (out.length === RECIPE_FIELD_LIMITS.tags) break;
  }
  return out;
}

function siteName(body: string): string | null {
  for (const meta of startTags(body, body.toLowerCase(), "meta")) {
    if ((meta.attributes.get("property") ?? "").trim().toLowerCase() !== "og:site_name") continue;
    const content = meta.attributes.get("content") ?? "";
    if (content.length > 200) return null;
    return cleanText(content) || null;
  }
  return null;
}

export type Extraction =
  | { readonly ok: true; readonly preview: Omit<RecipeImportPreview, "duplicates"> }
  | { readonly ok: false };

/** The recipe a page states, as an editable preview, or not-ok when it states none. */
export function extractRecipe(body: string, pageUrl: string): Extraction {
  let node: JsonObject | null = null;
  for (const block of jsonLdBlocks(body)) {
    node = findRecipe(block);
    if (node) break;
  }
  if (!node) return { ok: false };

  const warnings = new Set<RecipeImportWarning>();
  const cut = { shortened: false };

  const nameText = firstText(node.name);
  const name = nameText ? limit(nameText, RECIPE_FIELD_LIMITS.name, cut) : null;

  const lines = asArray(node.recipeIngredient ?? node.ingredients)
    .filter((item): item is string => typeof item === "string")
    .map((item) => cleanText(item))
    .filter((item) => item !== "");
  if (lines.length > RECIPE_FIELD_LIMITS.ingredients) warnings.add("tooManyItems");
  const ingredients = lines.slice(0, RECIPE_FIELD_LIMITS.ingredients).map((line) => {
    const parsed = parseIngredientLine(limit(line, RECIPE_FIELD_LIMITS.ingredientName, cut));
    if (parsed.asWritten) warnings.add("ingredientsAsWritten");
    return { ...parsed, name: limit(parsed.name, RECIPE_FIELD_LIMITS.ingredientName, cut) };
  });

  const allSteps = steps(node.recipeInstructions);
  if (allSteps.length > RECIPE_FIELD_LIMITS.steps) warnings.add("tooManyItems");
  const stepList = allSteps
    .slice(0, RECIPE_FIELD_LIMITS.steps)
    .map((step) => limit(step, RECIPE_FIELD_LIMITS.step, cut));

  const { servings, label } = servingsOf(node.recipeYield, warnings);
  const time = (value: Json | undefined) => {
    const minutes = durationMinutes(value);
    if (minutes !== null && minutes > RECIPE_FIELD_LIMITS.maxMinutes) {
      warnings.add("timeOutOfRange");
      return null;
    }
    return minutes;
  };
  const prepMinutes = time(node.prepTime);
  const cookMinutes = time(node.cookTime);

  const description = typeof node.description === "string" ? cleanText(node.description, true) : "";
  const notes = description === "" ? null : limit(description, RECIPE_FIELD_LIMITS.notes, cut);

  const host = new URL(pageUrl).hostname.replace(/^www\./u, "");
  const site = firstText(node.publisher) ?? siteName(body) ?? host;
  const author = firstText(node.author);
  const attribution = limit(author && author !== site ? `${site} · ${author}` : site, 200, cut);

  if (!name) warnings.add("noName");
  if (ingredients.length === 0) warnings.add("noIngredients");
  if (stepList.length === 0) warnings.add("noSteps");
  if (servings === null && !warnings.has("ambiguousServings")) warnings.add("noServings");
  if (asArray(node.image).length > 0) warnings.add("photoNotCopied");
  if (cut.shortened) warnings.add("textShortened");

  return {
    ok: true,
    preview: {
      source: { url: pageUrl, name: attribution },
      name,
      servings,
      servingsLabel: label,
      prepMinutes,
      cookMinutes,
      notes,
      tags: tags(node),
      ingredients,
      steps: stepList,
      warnings: [...warnings],
    },
  };
}
