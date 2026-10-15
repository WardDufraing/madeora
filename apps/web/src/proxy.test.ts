import { CORRELATION_HEADER, isCorrelationId } from "@madeora/observability";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { requestCorrelationId } from "@/api/correlation";

vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  }),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getSession: () => Promise.resolve({ data: {} }) } }),
}));

const { proxy } = await import("./proxy");

const FORGED = "0b6f3f2e-5d7a-4c1b-9e2f-1a2b3c4d5e6f";

/** The request headers Next.js forwards to the page or route handler. */
function forwarded(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

describe("proxy correlation IDs", () => {
  it("gives each request a fresh ID, forwarded to the handler and returned to the client", async () => {
    const first = await proxy(new NextRequest("http://localhost:3000/settings"));
    const second = await proxy(new NextRequest("http://localhost:3000/settings"));
    const id = first.headers.get(CORRELATION_HEADER);
    expect(isCorrelationId(id)).toBe(true);
    expect(forwarded(first, CORRELATION_HEADER)).toBe(id);
    expect(second.headers.get(CORRELATION_HEADER)).not.toBe(id);
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("replaces an ID sent by the client", async () => {
    const response = await proxy(
      new NextRequest("http://localhost:3000/api/v1/homes", {
        headers: { [CORRELATION_HEADER]: FORGED },
      }),
    );
    expect(response.headers.get(CORRELATION_HEADER)).not.toBe(FORGED);
    expect(forwarded(response, CORRELATION_HEADER)).not.toBe(FORGED);
  });
});

describe("requestCorrelationId", () => {
  it("reads the ID the proxy set", () => {
    const request = new Request("http://localhost/x", {
      headers: { [CORRELATION_HEADER]: FORGED },
    });
    expect(requestCorrelationId(request)).toBe(FORGED);
  });

  it.each([null, "not-an-id", `${FORGED}-extra`, FORGED.toUpperCase()])(
    "makes a fresh ID when the header is %j",
    (value) => {
      const headers = new Headers();
      if (value !== null) headers.set(CORRELATION_HEADER, value);
      const id = requestCorrelationId({ headers });
      expect(isCorrelationId(id)).toBe(true);
      expect(id).not.toBe(FORGED);
    },
  );
});
