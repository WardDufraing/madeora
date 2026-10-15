import { describe, expect, it } from "vitest";

import { presignUrl, signRequest, verifyPresignedUrl, type SigningCredentials } from "./sigv4.ts";

// The example credentials and expected signatures from AWS's S3 Signature Version 4 documentation
// ("Authenticating Requests: Using Query Parameters" and "Using the Authorization Header").
const aws: SigningCredentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
};
const exampleDay = new Date("2013-05-24T00:00:00Z");

describe("presignUrl", () => {
  it("matches AWS's published presigned GET example", () => {
    const url = presignUrl(aws, {
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      expiresInSeconds: 86400,
      now: exampleDay,
    });
    expect(new URL(url).searchParams.get("X-Amz-Signature")).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
    expect(url).toContain(
      "X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request",
    );
  });

  it("signs the headers a browser must send, so a different type or size is refused", () => {
    const url = presignUrl(aws, {
      method: "PUT",
      url: "https://store.example/bucket/u/" + "a".repeat(64),
      expiresInSeconds: 300,
      signedHeaders: { "content-type": "image/png", "content-length": "1000" },
      now: exampleDay,
    });
    expect(new URL(url).searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;content-type;host",
    );
    const check = (headers: Record<string, string>, method = "PUT", at = exampleDay) =>
      verifyPresignedUrl(aws, { method, url, headers: new Map(Object.entries(headers)), now: at });
    expect(check({ "content-type": "image/png", "content-length": "1000" })).toBe("ok");
    expect(check({ "content-type": "image/png", "content-length": "1001" })).toBe("bad-signature");
    expect(check({ "content-type": "text/html", "content-length": "1000" })).toBe("bad-signature");
    expect(check({ "content-type": "image/png" })).toBe("bad-signature");
    expect(check({ "content-type": "image/png", "content-length": "1000" }, "GET")).toBe(
      "bad-signature",
    );
    expect(
      check(
        { "content-type": "image/png", "content-length": "1000" },
        "PUT",
        new Date(exampleDay.getTime() + 301_000),
      ),
    ).toBe("expired");
  });

  it("refuses a link for another key, a forged signature or other credentials", () => {
    const url = presignUrl(aws, {
      method: "GET",
      url: "https://store.example/bucket/u/" + "a".repeat(64),
      expiresInSeconds: 60,
      now: exampleDay,
    });
    const headers = new Map<string, string>();
    const at = exampleDay;
    expect(verifyPresignedUrl(aws, { method: "GET", url, headers, now: at })).toBe("ok");
    expect(
      verifyPresignedUrl(aws, {
        method: "GET",
        url: url.replace("a".repeat(64), "b".repeat(64)),
        headers,
        now: at,
      }),
    ).toBe("bad-signature");
    expect(
      verifyPresignedUrl(aws, {
        method: "GET",
        url: url.replace(/X-Amz-Signature=[0-9a-f]+/, `X-Amz-Signature=${"0".repeat(64)}`),
        headers,
        now: at,
      }),
    ).toBe("bad-signature");
    expect(
      verifyPresignedUrl(
        { ...aws, secretAccessKey: "another-secret-key-of-enough-length" },
        { method: "GET", url, headers, now: at },
      ),
    ).toBe("bad-signature");
    expect(
      verifyPresignedUrl(aws, { method: "GET", url: url.split("?")[0] ?? "", headers, now: at }),
    ).toBe("malformed");
  });

  it("refuses expiries SigV4 does not allow", () => {
    const input = { method: "GET" as const, url: "https://s.example/b/k", now: exampleDay };
    expect(() => presignUrl(aws, { ...input, expiresInSeconds: 0 })).toThrow(RangeError);
    expect(() => presignUrl(aws, { ...input, expiresInSeconds: 604801 })).toThrow(RangeError);
  });
});

describe("signRequest", () => {
  it("matches AWS's published GET Object example", () => {
    const headers = signRequest(aws, {
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      headers: { range: "bytes=0-9" },
      now: exampleDay,
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("signs the body of a PUT", () => {
    const body = new TextEncoder().encode("hello");
    const headers = signRequest(aws, {
      method: "PUT",
      url: "https://s.example/b/k",
      body,
      now: exampleDay,
    });
    expect(headers["x-amz-content-sha256"]).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});
