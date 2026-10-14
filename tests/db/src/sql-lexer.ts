// A small SQL scanner for test SQL, so the runner can see statement boundaries the way psql does.
// It skips comments, string literals, quoted identifiers and dollar-quoted bodies (where PL/pgSQL
// `begin` and `end` live), and reports the first word of every top-level statement and whether a
// backslash (a psql meta-command such as \! or \c) appears outside quoted text.

export interface ScannedSql {
  /** The lower-cased first two words of every top-level statement, in order. */
  readonly statementHeads: readonly string[];
  /** True when a backslash appears outside comments, strings and dollar quotes. */
  readonly hasMetaCommand: boolean;
}

const identifierChar = /[A-Za-z0-9_$]/;
const dollarTag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

export function scanSql(sql: string): ScannedSql {
  let code = "";
  let i = 0;
  const previousIsIdentifier = (): boolean => i > 0 && identifierChar.test(sql.charAt(i - 1));

  while (i < sql.length) {
    const char = sql.charAt(i);
    const next = sql.charAt(i + 1);

    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      code += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith("/*", i)) {
          depth += 1;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      code += " ";
      continue;
    }
    if (char === "'") {
      // E'...' strings allow backslash escapes; standard strings only double the quote.
      const escapes =
        i > 0 &&
        /[eE]/.test(sql.charAt(i - 1)) &&
        !(i > 1 && identifierChar.test(sql.charAt(i - 2)));
      i += 1;
      while (i < sql.length) {
        const c = sql.charAt(i);
        if (escapes && c === "\\") {
          i += 2;
        } else if (c === "'" && sql.charAt(i + 1) === "'") {
          i += 2;
        } else if (c === "'") {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      code += " ";
      continue;
    }
    if (char === '"') {
      i += 1;
      while (i < sql.length) {
        if (sql.charAt(i) === '"' && sql.charAt(i + 1) === '"') i += 2;
        else if (sql.charAt(i) === '"') {
          i += 1;
          break;
        } else i += 1;
      }
      code += " x ";
      continue;
    }
    if (char === "$" && !previousIsIdentifier()) {
      const match = dollarTag.exec(sql.slice(i));
      if (match) {
        const tag = match[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
        code += " x ";
        continue;
      }
    }
    code += char;
    i += 1;
  }

  const statementHeads = code
    .split(";")
    .map((statement) => statement.trim().toLowerCase().split(/\s+/).slice(0, 2).join(" "))
    .filter((head) => head !== "");
  return { statementHeads, hasMetaCommand: code.includes("\\") };
}
