import { createLogger } from "@madeora/observability";
import { describe, expect, it } from "vitest";

import { DispatchRejectedError, dispatchOutbox } from "./dispatcher.ts";
import { createLocalDispatchClient, createLocalJobRunner } from "./local.ts";
import { jobRegistry } from "./registry.ts";
import { FakeJobStore } from "./testing/fake-store.ts";
import type { FakeMail } from "./testing/fake-services.ts";
import { fakeServices } from "./testing/fake-services.ts";

const logger = createLogger({ env: "test", sink: () => undefined });
const NOTIFICATION = "3f1b6c52-0a3e-4d9b-8f55-0d9c1b7a2e11";

function setup() {
  const store = new FakeJobStore();
  const services = fakeServices();
  services.data.notification = {
    outcome: "ok",
    to: "carol@example.test",
    locale: "en",
    kind: "recovery.claimant_paused",
    homeId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001",
    homeName: "Thuis",
    homeTimeZone: "Europe/Brussels",
    params: {},
  };
  const client = createLocalDispatchClient({ store, services, logger, retryDelayMs: 1 });
  const sweep = () => dispatchOutbox({ store, client, registry: jobRegistry, logger });
  const enqueue = () =>
    store.enqueue({
      jobName: "notification-email",
      idempotencyKey: `notification-email:${NOTIFICATION}`,
      payload: { notificationId: NOTIFICATION },
    });
  return { store, services, sweep, enqueue };
}

describe("local job runs", () => {
  it("dispatches an outbox row and sends its email in this process", async () => {
    const { services, sweep, enqueue } = setup();
    enqueue();
    const summary = await sweep();
    expect(summary).toMatchObject({ claimed: 1, dispatched: 1 });
    expect(services.mail?.delivered).toHaveLength(1);
  });

  it("retries a job that fails for a moment, with its idempotency key, and sends once", async () => {
    const { services, sweep, enqueue } = setup();
    (services.mail as FakeMail).results = [{ ok: false, reason: "unavailable" }];
    enqueue();
    await sweep();
    expect(services.mail?.requests).toHaveLength(2);
    expect(services.mail?.delivered).toHaveLength(1);
  });

  it("stops after a permanent failure without retrying", async () => {
    const { services, sweep, enqueue } = setup();
    (services.mail as FakeMail).results = [{ ok: false, reason: "rejected", status: 422 }];
    enqueue();
    await sweep();
    expect(services.mail?.requests).toHaveLength(1);
  });

  it("refuses a job it does not know", async () => {
    const { store, services } = setup();
    const client = createLocalDispatchClient({ store, services, logger });
    await expect(
      client.trigger(
        "nonsense",
        { v: 1, correlationId: "x", idempotencyKey: "k", data: {} },
        { idempotencyKey: "k" },
      ),
    ).rejects.toBeInstanceOf(DispatchRejectedError);
  });
});

describe("createLocalJobRunner", () => {
  const base = {
    supabaseUrl: "http://127.0.0.1:54321",
    serviceRoleKey: "sb_secret_" + "a".repeat(30),
    mailpitUrl: "http://127.0.0.1:54324",
    from: "Madeora Test <no-reply@madeora.test>",
    appUrl: "http://127.0.0.1:3100",
  };

  it("works with services on this machine", () => {
    expect(() => createLocalJobRunner(base)).not.toThrow();
  });

  it.each([
    { supabaseUrl: "https://abcdefghijklmnop.supabase.co" },
    { mailpitUrl: "https://mail.example.com" },
  ])("refuses anything that is not on this machine: %j", (override) => {
    expect(() => createLocalJobRunner({ ...base, ...override })).toThrow("on this machine");
  });
});
