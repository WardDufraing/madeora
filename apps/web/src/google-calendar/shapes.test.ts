import { describe, expect, it } from "vitest";

import { syncNotStarted } from "./shapes.ts";

const now = new Date("2026-11-19T10:00:00Z");
const base = {
  status: "connected" as const,
  connectedAt: "2026-11-19T09:30:00Z",
  lastSyncedAt: null,
  errorCode: null,
};

describe("syncNotStarted", () => {
  it("is true when connected long ago and never synced", () => {
    expect(syncNotStarted(base, now)).toBe(true);
  });
  it("is false right after connecting", () => {
    expect(syncNotStarted({ ...base, connectedAt: "2026-11-19T09:55:00Z" }, now)).toBe(false);
  });
  it("is false once a sync happened, on an error or when authorization expired", () => {
    expect(syncNotStarted({ ...base, lastSyncedAt: "2026-11-19T09:40:00Z" }, now)).toBe(false);
    expect(syncNotStarted({ ...base, errorCode: "x" }, now)).toBe(false);
    expect(syncNotStarted({ ...base, status: "authorization_expired" }, now)).toBe(false);
  });
});
