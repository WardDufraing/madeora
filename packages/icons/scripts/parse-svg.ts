/**
 * Strict reader for Madeora icon sources (architecture.md §16: never embed scripts, event
 * handlers, external references or untrusted markup).
 *
 * Instead of sanitizing arbitrary SVG, it accepts exactly one shape: the standard Madeora root
 * element (24×24 grid, 2px round stroke, `currentColor`) containing only flat `path`, `circle`,
 * `line`, `polyline` and `rect` elements with geometry attributes whose values are numbers or
 * path commands. Anything else (comments, text, other elements or attributes, entities, styles,
 * `href`, `on*` handlers, `url(...)`, `javascript:`) is refused with the reason.
 */

export type IconTag = "path" | "circle" | "line" | "polyline" | "rect";
export type IconElement = readonly [tag: IconTag, attributes: Readonly<Record<string, string>>];

export const ROOT_ATTRIBUTES: Readonly<Record<string, string>> = {
  xmlns: "http://www.w3.org/2000/svg",
  width: "24",
  height: "24",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
};

const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/;
const POINTS = /^[\d.,\s-]+$/;
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz\d.,\s-]+$/;

const ELEMENT_ATTRIBUTES: Readonly<Record<IconTag, Readonly<Record<string, RegExp>>>> = {
  path: { d: PATH_DATA },
  circle: { cx: NUMBER, cy: NUMBER, r: NUMBER },
  line: { x1: NUMBER, y1: NUMBER, x2: NUMBER, y2: NUMBER },
  polyline: { points: POINTS },
  rect: { x: NUMBER, y: NUMBER, width: NUMBER, height: NUMBER, rx: NUMBER, ry: NUMBER },
};

const ATTRIBUTE = /\s+([A-Za-z][\w:-]*)="([^"<>&]*)"/gy;

function readAttributes(source: string, where: string): Map<string, string> {
  const attributes = new Map<string, string>();
  ATTRIBUTE.lastIndex = 0;
  let consumed = 0;
  for (let match = ATTRIBUTE.exec(source); match; match = ATTRIBUTE.exec(source)) {
    const [whole, name = "", value = ""] = match;
    if (attributes.has(name)) throw new Error(`${where}: duplicate attribute "${name}".`);
    attributes.set(name, value);
    consumed += whole.length;
  }
  if (source.slice(consumed).trim() !== "") {
    throw new Error(`${where}: attributes must be name="value" pairs without &, < or >.`);
  }
  return attributes;
}

export function parseIconSvg(source: string, file = "icon"): IconElement[] {
  const root = /^\s*<svg(\s[^>]*?)?>([\s\S]*)<\/svg>\s*$/.exec(source);
  if (!root) throw new Error(`${file}: must be a single <svg> element and nothing else.`);

  const rootAttributes = readAttributes(root[1] ?? "", `${file} <svg>`);
  for (const [name, value] of rootAttributes) {
    if (ROOT_ATTRIBUTES[name] !== value) {
      throw new Error(`${file} <svg>: attribute ${name} is not allowed with this value.`);
    }
  }
  for (const name of Object.keys(ROOT_ATTRIBUTES)) {
    if (!rootAttributes.has(name)) throw new Error(`${file} <svg>: missing attribute ${name}.`);
  }

  const body = root[2] ?? "";
  const child = /\s*<([a-z]+)(\s[^<>]*?)?\s*\/>/y;
  const elements: IconElement[] = [];
  let position = 0;
  while (position < body.length) {
    if (body.slice(position).trim() === "") break;
    child.lastIndex = position;
    const match = child.exec(body);
    if (!match) {
      throw new Error(
        `${file}: only self-closing path, circle, line, polyline and rect elements are allowed.`,
      );
    }
    const tag = match[1] ?? "";
    if (!Object.hasOwn(ELEMENT_ATTRIBUTES, tag))
      throw new Error(`${file}: element <${tag}> is not allowed.`);
    const allowed = ELEMENT_ATTRIBUTES[tag as IconTag];
    const attributes = readAttributes(match[2] ?? "", `${file} <${tag}>`);
    if (attributes.size === 0) throw new Error(`${file} <${tag}>: has no geometry.`);
    for (const [name, value] of attributes) {
      const pattern = Object.hasOwn(allowed, name) ? allowed[name] : undefined;
      if (!pattern) throw new Error(`${file} <${tag}>: attribute ${name} is not allowed.`);
      if (!pattern.test(value))
        throw new Error(`${file} <${tag}>: attribute ${name} has an unsafe value.`);
    }
    elements.push([tag as IconTag, Object.fromEntries(attributes)]);
    position = child.lastIndex;
  }
  if (elements.length === 0) throw new Error(`${file}: has no shapes.`);
  return elements;
}

/** `arrow-left.svg` → `ArrowLeft`. */
export function componentName(fileName: string): string {
  const base = fileName.replace(/\.svg$/, "");
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(base)) {
    throw new Error(`${fileName}: icon file names are lower-case words joined by hyphens.`);
  }
  return base
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
