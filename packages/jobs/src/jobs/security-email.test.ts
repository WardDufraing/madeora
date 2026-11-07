import { createLogger } from "@madeora/observability";
import { describe, expect, it } from "vitest";

import type { JobEnvelope } from "../definition.ts";
import { runJob } from "../executor.ts";
import { FakeJobStore } from "../testing/fake-store.ts";
import { fakeServices } from "../testing/fake-services.ts";
import { accountRecoveryReady, securityEmail } from "./security-email.ts";

const CORRELATION = "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f";
const EMAIL = "5d1e2f3a-4b5c-4d6e-8f70-819203a4b5c6";
const RECOVERY = "c2d8e5f1-4a6b-4c7d-8e9f-0a1b2c3d4e5f";

function setup() {
  const store = new FakeJobStore();
  const lines: string[] = [];
  const logger = createLogger({ env: "test", sink: (_level, line) => lines.push(line) });
  return { store, lines, logger, services: fakeServices() };
}

function envelope(data: Record<string, unknown>, idempotencyKey: string): JobEnvelope {
  return { v: 1, correlationId: CORRELATION, idempotencyKey, data };
}

describe("security-email", () => {
  const key = `security-email:${EMAIL}`;
  const token = "S".repeat(43);

  it("sends the backup-address link and records it, never logging the secret", async () => {
    const ctx = setup();
    ctx.services.data.securityEmail = {
      outcome: "ok",
      kind: "backup_verify",
      to: "backup@example.test",
      locale: "nl",
      token,
      expiresAt: new Date("2026-11-06T10:00:00Z"),
    };
    await runJob(securityEmail, envelope({ emailId: EMAIL }, key), ctx);
    const [sent] = ctx.services.mail?.delivered ?? [];
    expect(sent?.to).toBe("backup@example.test");
    expect(sent?.idempotencyKey).toBe(key);
    expect(sent?.subject).toBe("Bevestig je reserve-e-mailadres voor Madeora");
    expect(sent?.text).toContain(
      `https://app.madeora.test/auth/confirm-backup-email?token=${token}`,
    );
    expect(ctx.services.data.securityRecords).toEqual([{ id: EMAIL, status: "sent" }]);
    expect(ctx.lines.join("\n")).not.toContain(token);
  });

  it.each([
    ["recovery_link", "/account-recovery/continue"],
    ["recovery_ready", "/account-recovery/finish"],
  ] as const)("links %s to its page", async (kind, path) => {
    const ctx = setup();
    ctx.services.data.securityEmail = {
      outcome: "ok",
      kind,
      to: "backup@example.test",
      locale: "en",
      token,
      expiresAt: null,
    };
    await runJob(securityEmail, envelope({ emailId: EMAIL }, key), ctx);
    expect(ctx.services.mail?.delivered[0]?.text).toContain(`${path}?token=${token}`);
  });

  it("sends the waiting-period notice without a link", async () => {
    const ctx = setup();
    ctx.services.data.securityEmail = {
      outcome: "ok",
      kind: "recovery_started",
      to: "backup@example.test",
      locale: "en",
      token: null,
      expiresAt: null,
    };
    await runJob(securityEmail, envelope({ emailId: EMAIL }, key), ctx);
    const [sent] = ctx.services.mail?.delivered ?? [];
    expect(sent?.subject).toBe("Your Madeora account recovery has started");
    expect(sent?.text).not.toContain("https://");
  });

  it("sends nothing for an expired or already sent email", async () => {
    const ctx = setup();
    const result = await runJob(securityEmail, envelope({ emailId: EMAIL }, key), ctx);
    expect(result.status).toBe("succeeded");
    expect(ctx.services.mail?.requests).toHaveLength(0);
    expect(ctx.services.data.securityRecords).toEqual([]);
  });
});

describe("account-recovery-ready", () => {
  it("asks the database to deliver the end of the wait it was queued for", async () => {
    const ctx = setup();
    ctx.services.data.accountRecoveryOutcome = "notified";
    const readyAt = "2026-11-09T07:52:12.552+00:00";
    await runJob(
      accountRecoveryReady,
      envelope({ recoveryId: RECOVERY, readyAt }, `account-recovery-ready:${RECOVERY}`),
      ctx,
    );
    expect(ctx.services.data.accountRecoveryCalls).toEqual([
      { recoveryId: RECOVERY, readyAt: new Date(readyAt) },
    ]);
  });
});
