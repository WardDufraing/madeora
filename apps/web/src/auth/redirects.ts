/** Where people land after signing in when no (valid) destination was asked for. */
export const DEFAULT_SIGNED_IN_PATH = "/";

/**
 * Accepts a post-sign-in destination only when it is a path on this site, such as `/tasks?x=1`.
 * Anything that a browser could resolve to another origin (`//evil.example`, `/\evil.example`,
 * `https://…`, control characters) falls back to the dashboard, so a crafted sign-in link cannot
 * send someone to another site (open redirect).
 */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || value.length > 2048) return DEFAULT_SIGNED_IN_PATH;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return DEFAULT_SIGNED_IN_PATH;
  }
  // Browsers drop tabs and newlines inside URLs, so "/\t/evil.example" would become "//evil.example".
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return DEFAULT_SIGNED_IN_PATH;
  try {
    const base = "https://madeora.invalid";
    const url = new URL(value, base);
    if (url.origin !== base) return DEFAULT_SIGNED_IN_PATH;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return DEFAULT_SIGNED_IN_PATH;
  }
}

/** The sign-in page address that returns to `path` afterwards. */
export function signInPath(path: string | null | undefined): string {
  const next = safeNextPath(path);
  return next === DEFAULT_SIGNED_IN_PATH ? "/sign-in" : `/sign-in?next=${encodeURIComponent(next)}`;
}
