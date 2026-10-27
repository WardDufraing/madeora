/**
 * Linear-time reading of the little markup a recipe import needs (S25, ARCH §38: fetched content is
 * untrusted). A hostile page must not be able to make the server work longer than the size of what
 * it sent, so there are no regular expressions over the page: tags are found with `indexOf`, every
 * search position only moves forward, and a tag's attributes are read only within a bounded window.
 */

/** The longest start tag read; a longer one is skipped as text. */
const TAG_WINDOW = 2000;

const tagNameChar = /^[a-z0-9:-]$/u;

/** A tag's name ("script", "/p" → "p") and whether it closes, from the text between `<` and `>`. */
function tagName(inner: string): { readonly name: string; readonly closing: boolean } {
  let index = 0;
  while (index < inner.length && inner.charCodeAt(index) <= 32) index += 1;
  const closing = inner[index] === "/";
  if (closing) index += 1;
  while (index < inner.length && inner.charCodeAt(index) <= 32) index += 1;
  const start = index;
  while (index < inner.length && tagNameChar.test(inner[index] ?? "")) index += 1;
  return { name: inner.slice(start, index).toLowerCase(), closing };
}

/**
 * The attributes of a start tag (names lower-cased; the first of a repeated name wins). The text is
 * at most TAG_WINDOW characters, and each character is looked at a bounded number of times.
 */
export function tagAttributes(text: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  const isSpace = (at: number) => at < text.length && text.charCodeAt(at) <= 32;
  let index = 0;
  while (index < text.length) {
    while (isSpace(index) || text[index] === "/") index += 1;
    const start = index;
    while (index < text.length && !isSpace(index) && !"=/>\"'".includes(text[index] ?? "")) {
      index += 1;
    }
    if (index === start) {
      index += 1;
      continue;
    }
    const name = text.slice(start, index).toLowerCase();
    while (isSpace(index)) index += 1;
    let value = "";
    if (text[index] === "=") {
      index += 1;
      while (isSpace(index)) index += 1;
      const quote = text[index];
      if (quote === '"' || quote === "'") {
        const end = text.indexOf(quote, index + 1);
        const stop = end === -1 ? text.length : end;
        value = text.slice(index + 1, stop);
        index = stop + 1;
      } else {
        const valueStart = index;
        while (index < text.length && !isSpace(index)) index += 1;
        value = text.slice(valueStart, index);
      }
    }
    if (!attributes.has(name)) attributes.set(name, value);
  }
  return attributes;
}

export interface StartTag {
  readonly attributes: ReadonlyMap<string, string>;
  /** Where the tag ends (just after its `>`). */
  readonly end: number;
}

/**
 * Every start tag named `name` in `body`, in order. `lower` is `body.toLowerCase()`, computed once
 * by the caller. `after(tag)` may answer where to continue (for example past a closing tag).
 */
export function* startTags(
  body: string,
  lower: string,
  name: string,
): Generator<StartTag, void, number | undefined> {
  const opener = `<${name}`;
  let from = 0;
  // The next `>` at or after the current position: searched once, reused while it is still ahead.
  let gt = -1;
  for (;;) {
    const at = lower.indexOf(opener, from);
    if (at === -1) return;
    const attributesStart = at + opener.length;
    if (tagNameChar.test(lower[attributesStart] ?? "")) {
      from = attributesStart;
      continue;
    }
    if (gt < attributesStart) gt = lower.indexOf(">", attributesStart);
    if (gt === -1) return;
    if (gt - attributesStart > TAG_WINDOW) {
      from = attributesStart;
      continue;
    }
    const next = yield {
      attributes: tagAttributes(body.slice(attributesStart, gt)),
      end: gt + 1,
    };
    from = Math.max(gt + 1, next ?? 0);
  }
}

// Inline formatting joins its text to the words around it ("<b>every</b>thing"); other tags separate words.
const inlineTags = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "code",
  "em",
  "i",
  "mark",
  "q",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "u",
]);

/**
 * Text without its tags: `<br>` and `</p>` become line breaks, inline formatting disappears, other
 * tags become a space, and `<script>`/`<style>` lose their contents too. A `<` without a later `>`
 * stays as text. Linear in the length of `value`.
 */
export function stripTags(value: string): string {
  const lower = value.toLowerCase();
  const parts: string[] = [];
  // Whether a closing tag was looked for and is absent from here on: never searched for again.
  const noCloser = new Set<string>();
  let index = 0;
  let gt = -1;
  while (index < value.length) {
    const lt = value.indexOf("<", index);
    if (lt === -1) {
      parts.push(value.slice(index));
      break;
    }
    parts.push(value.slice(index, lt));
    if (gt <= lt) gt = value.indexOf(">", lt + 1);
    if (gt === -1) {
      parts.push(value.slice(lt));
      break;
    }
    const { name, closing } = tagName(value.slice(lt + 1, Math.min(gt, lt + 1 + 64)));
    index = gt + 1;
    if (!closing && (name === "script" || name === "style") && !noCloser.has(name)) {
      const closer = lower.indexOf(`</${name}`, index);
      if (closer === -1) {
        noCloser.add(name);
      } else {
        const end = lower.indexOf(">", closer);
        index = end === -1 ? value.length : end + 1;
      }
      parts.push(" ");
      continue;
    }
    if (name === "br" || (closing && name === "p")) parts.push("\n");
    else if (!inlineTags.has(name)) parts.push(" ");
  }
  return parts.join("");
}
