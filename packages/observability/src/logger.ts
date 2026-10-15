/**
 * Structured, privacy-safe logging (architecture.md §22, CLAUDE.md observability strategy B).
 *
 * One JSON object per line, which Vercel, Supabase and Trigger.dev all show and filter as is:
 * `ts`, `level`, `event`, `env`, `correlationId` and whatever fields the caller adds. Callers name
 * what happened (`event`, a stable dotted name such as `jobs.outbox.dispatched`) and pass ids and
 * sanitized codes, never messages, bodies or personal data.
 *
 * Redaction is a safety net, not permission to log sensitive data:
 * - a field whose name looks sensitive (token, secret, password, cookie, email, url, body, ...)
 *   is replaced by `[redacted]`, whatever its value;
 * - token-shaped substrings in any string (JWTs, provider keys, bearer tokens, email addresses,
 *   query strings of URLs, which may hold signatures) are masked;
 * - strings are cut to 200 characters, so a stray body cannot fill a log line.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogValue = string | number | boolean | null | undefined;

export type LogFields = Readonly<Record<string, LogValue>>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line (for example a job name or a correlation ID). */
  child(fields: LogFields): Logger;
}

/** Where finished lines go; the default writes to stdout (debug, info) or stderr (warn, error). */
export type LogSink = (level: LogLevel, line: string) => void;

export interface LoggerOptions {
  /** `APP_ENV` (development, test, preview, staging, production) or the job platform's name. */
  readonly env: string;
  readonly correlationId?: string;
  readonly fields?: LogFields;
  readonly sink?: LogSink;
  readonly now?: () => Date;
}

export const REDACTED = "[redacted]";

const MAX_STRING = 200;

// Field names whose values are never logged. Matched case-insensitively against the whole name,
// so `accessToken`, `RESEND_API_KEY`, `recipientEmail`, `signedUrl` and `displayName` are all
// caught. Name the job `job` and the event `event`; any field with "name" in it is redacted.
const SENSITIVE_KEY =
  /key$|name|token|secret|passw|pwd|authori[sz]ation|cookie|api[-_]?key|credential|signature|session|e-?mail|url|uri|body|html|content|message|statement|phone|address|note|payload/i;

// Fields the logger itself writes; callers cannot overwrite them.
const RESERVED = new Set(["ts", "level", "event", "env", "correlationId"]);

const VALUE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // JSON Web Tokens (Supabase access tokens, service-role keys).
  [/eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, "[jwt]"],
  // Provider keys: Resend, Trigger.dev, Supabase secret and publishable keys, Stripe-style keys.
  [
    /\b(?:re|tr_(?:dev|prod|stg|preview)|sb_(?:secret|publishable)|sk|pk|rk)_[A-Za-z0-9_-]{8,}/g,
    "[key]",
  ],
  [/\bBearer\s+\S+/gi, "Bearer [token]"],
  [/[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g, "[email]"],
  // Query strings and fragments of URLs: signed URLs and invitation links carry secrets there.
  [/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/gi, "$1?[redacted]"],
];

function scrub(value: string): string {
  let result = value;
  for (const [pattern, replacement] of VALUE_PATTERNS)
    result = result.replace(pattern, replacement);
  return result.length > MAX_STRING ? `${result.slice(0, MAX_STRING)}…` : result;
}

/** A field value as it may appear in a log line. */
export function sanitizeLogValue(key: string, value: LogValue): LogValue {
  if (value === undefined || value === null) return value;
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (typeof value === "string") return scrub(value);
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

// Event names are code, not data: a stable dotted identifier.
const EVENT_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;

const defaultSink: LogSink = (level, line) => {
  if (level === "warn" || level === "error") console.error(line);
  else console.log(line);
};

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());
  const base: LogFields = options.fields ?? {};

  const write = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    const line: Record<string, LogValue> = {
      ts: now().toISOString(),
      level,
      event: EVENT_NAME.test(event) && event.length <= 100 ? event : "log.invalid_event_name",
      env: scrub(options.env),
    };
    if (options.correlationId !== undefined) {
      line.correlationId = sanitizeLogValue("correlationId", options.correlationId);
    }
    for (const [key, value] of [...Object.entries(base), ...Object.entries(fields)]) {
      if (RESERVED.has(key) || value === undefined) continue;
      line[key.slice(0, 64)] = sanitizeLogValue(key, value);
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(line);
    } catch {
      serialized = JSON.stringify({ ts: line.ts, level, event: "log.unserializable" });
    }
    sink(level, serialized);
  };

  return {
    debug: (event, fields) => {
      write("debug", event, fields);
    },
    info: (event, fields) => {
      write("info", event, fields);
    },
    warn: (event, fields) => {
      write("warn", event, fields);
    },
    error: (event, fields) => {
      write("error", event, fields);
    },
    child: (fields) => {
      const { correlationId, ...rest } = fields;
      return createLogger({
        ...options,
        ...(typeof correlationId === "string" ? { correlationId } : {}),
        fields: { ...base, ...rest },
      });
    },
  };
}
