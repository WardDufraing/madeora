// Evaluates `pnpm audit --json` output against recorded, time-limited exceptions.
import { z } from "zod";

/** Severities that fail the check unless an unexpired exception covers them. */
export const BLOCKING_SEVERITIES: ReadonlySet<string> = new Set(["high", "critical"]);

/** An exception may last at most this many days from the day it was added. */
export const MAX_EXCEPTION_DAYS = 90;

const isoDate = z.iso.date();

export const exceptionsFileSchema = z
  .object({
    exceptions: z.array(
      z
        .object({
          id: z.string().regex(/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/, "must be a GHSA id"),
          package: z.string().min(1),
          reason: z.string().min(20, "explain why the advisory does not affect Madeora"),
          added: isoDate,
          expires: isoDate,
        })
        .strict(),
    ),
  })
  .strict();

export type AuditException = z.infer<typeof exceptionsFileSchema>["exceptions"][number];

const auditReportSchema = z.object({
  advisories: z.record(
    z.string(),
    z.object({
      github_advisory_id: z.string(),
      module_name: z.string(),
      severity: z.string(),
      title: z.string(),
      url: z.string(),
    }),
  ),
});

export interface Advisory {
  id: string;
  package: string;
  severity: string;
  title: string;
  url: string;
}

export interface AuditResult {
  /** Blocking advisories with no valid exception. */
  blocking: Advisory[];
  /** Blocking advisories covered by an unexpired exception. */
  excepted: Advisory[];
  /** Advisories below the blocking level, reported but not failing. */
  warnings: Advisory[];
  /** Problems with the exceptions themselves (expired, too long). */
  exceptionProblems: string[];
  /** Exceptions that no longer match any advisory and can be removed. */
  unused: AuditException[];
}

export function parseAuditReport(json: string): Advisory[] {
  const report = auditReportSchema.parse(JSON.parse(json));
  return Object.values(report.advisories).map((advisory) => ({
    id: advisory.github_advisory_id,
    package: advisory.module_name,
    severity: advisory.severity,
    title: advisory.title,
    url: advisory.url,
  }));
}

function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

/** `today` is a UTC calendar date (YYYY-MM-DD). An exception is valid through its `expires` day. */
export function evaluateAudit(
  advisories: readonly Advisory[],
  exceptions: readonly AuditException[],
  today: string,
): AuditResult {
  const exceptionProblems: string[] = [];
  const valid = exceptions.filter((exception) => {
    const label = `${exception.id} (${exception.package})`;
    if (daysBetween(exception.added, exception.expires) > MAX_EXCEPTION_DAYS) {
      exceptionProblems.push(
        `${label}: lasts longer than ${String(MAX_EXCEPTION_DAYS)} days; shorten "expires"`,
      );
      return false;
    }
    if (exception.expires < today) {
      exceptionProblems.push(
        `${label}: expired on ${exception.expires}; re-assess the advisory and renew or remove it`,
      );
      return false;
    }
    return true;
  });

  const matches = (advisory: Advisory, exception: AuditException) =>
    exception.id === advisory.id && exception.package === advisory.package;

  const result: AuditResult = {
    blocking: [],
    excepted: [],
    warnings: [],
    exceptionProblems,
    unused: exceptions.filter((exception) => !advisories.some((a) => matches(a, exception))),
  };
  for (const advisory of advisories) {
    if (!BLOCKING_SEVERITIES.has(advisory.severity)) {
      result.warnings.push(advisory);
    } else if (valid.some((exception) => matches(advisory, exception))) {
      result.excepted.push(advisory);
    } else {
      result.blocking.push(advisory);
    }
  }
  return result;
}

export function auditPassed(result: AuditResult): boolean {
  return result.blocking.length === 0 && result.exceptionProblems.length === 0;
}
