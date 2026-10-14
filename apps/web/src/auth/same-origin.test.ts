import { isSameOriginRequest } from "./same-origin";

const appUrl = "https://madeora.example";

function check(headers: Record<string, string>): boolean {
  return isSameOriginRequest(new Headers(headers), appUrl);
}

describe("isSameOriginRequest", () => {
  it("accepts the app's own origin", () => {
    expect(check({ origin: "https://madeora.example", host: "elsewhere.example" })).toBe(true);
  });

  it("accepts the host the request was sent to, as on a preview deployment", () => {
    expect(check({ origin: "https://preview-1.vercel.app", host: "preview-1.vercel.app" })).toBe(
      true,
    );
    expect(
      check({
        origin: "https://preview-1.vercel.app",
        host: "internal:3000",
        "x-forwarded-host": "preview-1.vercel.app",
      }),
    ).toBe(true);
  });

  it("refuses another site, an opaque origin and a malformed one", () => {
    expect(check({ origin: "https://evil.example", host: "madeora.example" })).toBe(false);
    expect(check({ origin: "null", host: "madeora.example" })).toBe(false);
    expect(check({ origin: "not a url", host: "madeora.example" })).toBe(false);
    expect(check({ origin: "ftp://madeora.example", host: "madeora.example" })).toBe(false);
  });

  it("refuses a different scheme or port on the same host name", () => {
    expect(check({ origin: "http://madeora.example", host: "madeora.example:8443" })).toBe(false);
    expect(check({ origin: "https://madeora.example:8443", host: "madeora.example" })).toBe(false);
  });

  it("without Origin, trusts only the browser's Sec-Fetch-Site: same-origin", () => {
    expect(check({ "sec-fetch-site": "same-origin" })).toBe(true);
    expect(check({ "sec-fetch-site": "same-site" })).toBe(false);
    expect(check({ "sec-fetch-site": "cross-site" })).toBe(false);
    expect(check({})).toBe(false);
  });
});
