import { describe, expect, it } from "vitest";

import {
  auditPassed,
  evaluateAudit,
  exceptionsFileSchema,
  parseAuditReport,
  type Advisory,
  type AuditException,
} from "./audit.ts";
import exceptionsFile from "../audit-exceptions.json" with { type: "json" };

const braces: Advisory = {
  id: "GHSA-vfj7-8cjw-p6xm",
  package: "braces",
  severity: "high",
  title: "braces stack exhaustion",
  url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
};

const exception: AuditException = {
  id: "GHSA-vfj7-8cjw-p6xm",
  package: "braces",
  reason: "Lint tooling only, never handles untrusted input.",
  added: "2026-10-13",
  expires: "2026-12-31",
};

describe("evaluateAudit", () => {
  it("passes with no advisories", () => {
    expect(auditPassed(evaluateAudit([], [], "2026-10-13"))).toBe(true);
  });

  it("blocks high and critical advisories without an exception", () => {
    const critical = { ...braces, id: "GHSA-2222-3333-4444", severity: "critical" };
    const result = evaluateAudit([braces, critical], [], "2026-10-13");
    expect(result.blocking).toEqual([braces, critical]);
    expect(auditPassed(result)).toBe(false);
  });

  it("reports moderate and low advisories without failing", () => {
    const moderate = { ...braces, severity: "moderate" };
    const result = evaluateAudit([moderate], [], "2026-10-13");
    expect(result.warnings).toEqual([moderate]);
    expect(auditPassed(result)).toBe(true);
  });

  it("allows an advisory covered by an unexpired exception, up to and including its last day", () => {
    for (const today of ["2026-10-13", "2026-12-31"]) {
      const result = evaluateAudit([braces], [exception], today);
      expect(result.excepted).toEqual([braces]);
      expect(auditPassed(result)).toBe(true);
    }
  });

  it("fails once the exception has expired", () => {
    const result = evaluateAudit([braces], [exception], "2027-01-01");
    expect(result.blocking).toEqual([braces]);
    expect(result.exceptionProblems[0]).toContain("expired on 2026-12-31");
    expect(auditPassed(result)).toBe(false);
  });

  it("fails an expired exception even when its advisory is gone, so stale entries get cleaned up", () => {
    const result = evaluateAudit([], [exception], "2027-01-01");
    expect(auditPassed(result)).toBe(false);
  });

  it("rejects an exception that lasts longer than 90 days", () => {
    const longLived = { ...exception, expires: "2027-06-01" };
    const result = evaluateAudit([braces], [longLived], "2026-10-13");
    expect(result.blocking).toEqual([braces]);
    expect(result.exceptionProblems[0]).toContain("longer than 90 days");
  });

  it("only matches the same advisory in the same package", () => {
    const otherPackage = { ...braces, package: "not-braces" };
    const otherAdvisory = { ...braces, id: "GHSA-2222-3333-4444" };
    const result = evaluateAudit([otherPackage, otherAdvisory], [exception], "2026-10-13");
    expect(result.blocking).toEqual([otherPackage, otherAdvisory]);
  });

  it("lists exceptions that no longer match any advisory", () => {
    expect(evaluateAudit([], [exception], "2026-10-13").unused).toEqual([exception]);
  });
});

describe("parseAuditReport", () => {
  it("reads advisories from pnpm audit --json output", () => {
    const json = JSON.stringify({
      advisories: {
        "1240992": {
          github_advisory_id: braces.id,
          module_name: "braces",
          severity: "high",
          title: braces.title,
          url: braces.url,
          findings: [],
        },
      },
      metadata: {},
    });
    expect(parseAuditReport(json)).toEqual([braces]);
  });

  it("throws on output that is not an audit report, so the check fails closed", () => {
    expect(() => parseAuditReport('{"error":{"code":"ERR_PNPM_AUDIT_BAD_RESPONSE"}}')).toThrow();
    expect(() => parseAuditReport("not json")).toThrow();
  });
});

describe("exceptions file", () => {
  it("is valid", () => {
    expect(() => exceptionsFileSchema.parse(exceptionsFile)).not.toThrow();
  });

  it("rejects entries without a real reason or with unknown fields", () => {
    expect(() =>
      exceptionsFileSchema.parse({ exceptions: [{ ...exception, reason: "ok" }] }),
    ).toThrow();
    expect(() =>
      exceptionsFileSchema.parse({ exceptions: [{ ...exception, approvedForever: true }] }),
    ).toThrow();
  });
});
