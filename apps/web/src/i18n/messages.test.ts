import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTranslator } from "next-intl";

import { locales } from "./locales";
import en from "./messages/en.json";
import nl from "./messages/nl.json";

type Tree = { readonly [key: string]: string | Tree };
const dictionaries: Record<(typeof locales)[number], Tree> = { en, nl };

/** Every message as `Namespace.key` → text. */
function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") result.set(path, value);
    else for (const [k, v] of flatten(value, path)) result.set(k, v);
  }
  return result;
}

/** ICU argument names used by a message, such as `section` in "{section} is …". */
function argumentsOf(message: string): string[] {
  return [...new Set([...message.matchAll(/\{\s*(\w+)\s*[,}]/g)].map((m) => m[1] ?? ""))].sort();
}

const english = flatten(en);

describe("message dictionaries", () => {
  it.each(locales)("%s has exactly the English keys, none empty", (locale) => {
    const messages = flatten(dictionaries[locale]);
    expect([...messages.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, text] of messages) expect(text.trim(), key).not.toBe("");
  });

  it.each(locales)("%s uses the same ICU arguments as English in every message", (locale) => {
    for (const [key, text] of flatten(dictionaries[locale])) {
      expect(argumentsOf(text), key).toEqual(argumentsOf(english.get(key) ?? ""));
    }
  });

  it.each(locales)("%s messages all format without errors", (locale) => {
    const errors: string[] = [];
    const t = createTranslator({
      locale,
      messages: dictionaries[locale],
      onError: (error) => errors.push(error.message),
    }) as unknown as (key: string, values?: Record<string, string>) => string;
    for (const [key, text] of flatten(dictionaries[locale])) {
      const values = Object.fromEntries(argumentsOf(text).map((name) => [name, "x"]));
      expect(typeof t(key, values)).toBe("string");
    }
    expect(errors).toEqual([]);
  });

  it("has no unused messages: every key appears as a string in the web app's source", () => {
    const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = `${dir}/${entry}`;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(path);
      }
    };
    walk(sourceRoot);
    const source = files.map((file) => readFileSync(file, "utf8")).join("\n");

    // A key is used when its last part is written as a string literal: t("theme"), or a
    // navigation id such as id: "calendar" whose label is looked up as tNav(item.id).
    const unused = [...english.keys()].filter((key) => {
      const name = key.split(".").at(-1) ?? key;
      return !source.includes(`"${name}"`);
    });
    expect(unused).toEqual([]);
  });
});
