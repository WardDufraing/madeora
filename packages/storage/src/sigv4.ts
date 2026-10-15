/**
 * AWS Signature Version 4 for the S3 API, which Cloudflare R2 speaks (architecture.md §10). Written
 * here rather than taken from a library because the upload links must sign `content-type` and
 * `content-length`, which small SigV4 libraries leave unsigned, and the AWS SDK is far larger than
 * the five operations Madeora needs. Checked against AWS's published examples (sigv4.test.ts).
 *
 * Server only: it handles the secret access key. Never log a signed URL or an Authorization header.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface SigningCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** `auto` for R2; an AWS region elsewhere. */
  readonly region: string;
}

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 encoding as SigV4 requires: everything but A–Z a–z 0–9 - _ . ~ is percent-encoded. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The path with each segment encoded once (S3 does not double-encode). */
function canonicalPath(url: URL): string {
  const path = url.pathname === "" ? "/" : url.pathname;
  return path
    .split("/")
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join("/");
}

function canonicalQuery(params: ReadonlyMap<string, string>): string {
  return [...params.entries()]
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort(([a, aValue], [b, bValue]) => (a === b ? (aValue < bValue ? -1 : 1) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/** `20130524T000000Z` and `20130524` for a moment. */
export function amzDates(now: Date): { readonly amzDate: string; readonly day: string } {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return { amzDate, day: amzDate.slice(0, 8) };
}

function signingKey(secret: string, day: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${secret}`, day);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, SERVICE);
  return hmac(serviceKey, "aws4_request");
}

interface CanonicalInput {
  readonly method: string;
  readonly url: URL;
  readonly query: ReadonlyMap<string, string>;
  /** Lower-case names. `host` is added from the URL. */
  readonly headers: ReadonlyMap<string, string>;
  readonly payloadHash: string;
}

function canonicalRequest(input: CanonicalInput): {
  readonly request: string;
  readonly signedHeaders: string;
} {
  const headers = new Map(input.headers);
  headers.set("host", input.url.host);
  const names = [...headers.keys()].map((name) => name.toLowerCase()).sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${(headers.get(name) ?? "").trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");
  return {
    request: [
      input.method,
      canonicalPath(input.url),
      canonicalQuery(input.query),
      canonicalHeaders,
      signedHeaders,
      input.payloadHash,
    ].join("\n"),
    signedHeaders,
  };
}

function signature(
  credentials: SigningCredentials,
  amzDate: string,
  day: string,
  request: string,
): { readonly scope: string; readonly value: string } {
  const scope = `${day}/${credentials.region}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(request)].join("\n");
  return {
    scope,
    value: createHmac("sha256", signingKey(credentials.secretAccessKey, day, credentials.region))
      .update(stringToSign, "utf8")
      .digest("hex"),
  };
}

export interface PresignInput {
  readonly method: "GET" | "PUT";
  /** The object's full URL, without a query string, or with only the parameters to sign. */
  readonly url: string;
  readonly expiresInSeconds: number;
  /** Headers the browser must send with exactly these values (lower-case names). */
  readonly signedHeaders?: Readonly<Record<string, string>>;
  readonly now: Date;
}

/** A presigned URL (query-string authentication). Anyone holding it can use it until it expires. */
export function presignUrl(credentials: SigningCredentials, input: PresignInput): string {
  if (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds < 1) {
    throw new RangeError("expiresInSeconds must be a positive integer");
  }
  if (input.expiresInSeconds > 604800) throw new RangeError("SigV4 links last at most 7 days");
  const url = new URL(input.url);
  const { amzDate, day } = amzDates(input.now);
  const headers = new Map(
    Object.entries(input.signedHeaders ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const headerNames = [...new Set([...headers.keys(), "host"])].sort().join(";");
  const query = new Map(url.searchParams);
  query.set("X-Amz-Algorithm", ALGORITHM);
  query.set(
    "X-Amz-Credential",
    `${credentials.accessKeyId}/${day}/${credentials.region}/${SERVICE}/aws4_request`,
  );
  query.set("X-Amz-Date", amzDate);
  query.set("X-Amz-Expires", String(input.expiresInSeconds));
  query.set("X-Amz-SignedHeaders", headerNames);
  const { request } = canonicalRequest({
    method: input.method,
    url,
    query,
    headers,
    payloadHash: UNSIGNED_PAYLOAD,
  });
  const { value } = signature(credentials, amzDate, day, request);
  query.set("X-Amz-Signature", value);
  return `${url.origin}${canonicalPath(url)}?${canonicalQuery(query)}`;
}

export interface SignRequestInput {
  readonly method: "GET" | "HEAD" | "PUT" | "DELETE";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** The body for PUT; its SHA-256 is signed. Other methods send none. */
  readonly body?: Uint8Array;
  readonly now: Date;
}

/** The headers (with Authorization) for a server-side request (header authentication). */
export function signRequest(
  credentials: SigningCredentials,
  input: SignRequestInput,
): Record<string, string> {
  const url = new URL(input.url);
  const { amzDate, day } = amzDates(input.now);
  const payloadHash = sha256Hex(input.body ?? new Uint8Array());
  const headers = new Map(
    Object.entries(input.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  headers.set("x-amz-date", amzDate);
  headers.set("x-amz-content-sha256", payloadHash);
  const { request, signedHeaders } = canonicalRequest({
    method: input.method,
    url,
    query: new Map(url.searchParams),
    headers,
    payloadHash,
  });
  const { scope, value } = signature(credentials, amzDate, day, request);
  return {
    ...Object.fromEntries(headers),
    authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${value}`,
  };
}

/**
 * Verifies a presigned URL as S3 would: the signature, the expiry and the signed headers. Used only
 * by the local S3 stand-in (tools/s3-stand-in) and tests; R2 does this itself in production.
 */
export function verifyPresignedUrl(
  credentials: SigningCredentials,
  request: {
    readonly method: string;
    readonly url: string;
    readonly headers: ReadonlyMap<string, string>;
    readonly now: Date;
  },
): "ok" | "expired" | "bad-signature" | "malformed" {
  const url = new URL(request.url);
  const params = new Map(url.searchParams);
  const amzDate = params.get("X-Amz-Date");
  const expires = Number(params.get("X-Amz-Expires"));
  const signed = params.get("X-Amz-SignedHeaders");
  const given = params.get("X-Amz-Signature");
  const credential = params.get("X-Amz-Credential");
  if (
    params.get("X-Amz-Algorithm") !== ALGORITHM ||
    !amzDate ||
    !/^\d{8}T\d{6}Z$/.test(amzDate) ||
    !Number.isInteger(expires) ||
    expires < 1 ||
    !signed ||
    !given ||
    credential !==
      `${credentials.accessKeyId}/${amzDate.slice(0, 8)}/${credentials.region}/${SERVICE}/aws4_request`
  ) {
    return "malformed";
  }
  const signedAt = Date.UTC(
    Number(amzDate.slice(0, 4)),
    Number(amzDate.slice(4, 6)) - 1,
    Number(amzDate.slice(6, 8)),
    Number(amzDate.slice(9, 11)),
    Number(amzDate.slice(11, 13)),
    Number(amzDate.slice(13, 15)),
  );
  if (request.now.getTime() > signedAt + expires * 1000) return "expired";
  params.delete("X-Amz-Signature");
  const headers = new Map<string, string>();
  for (const name of signed.split(";")) {
    if (name === "host") continue;
    const value = request.headers.get(name);
    if (value === undefined) return "bad-signature";
    headers.set(name, value);
  }
  const { request: canonical } = canonicalRequest({
    method: request.method,
    url,
    query: params,
    headers,
    payloadHash: UNSIGNED_PAYLOAD,
  });
  const { value } = signature(credentials, amzDate, amzDate.slice(0, 8), canonical);
  const expected = Buffer.from(value, "utf8");
  const actual = Buffer.from(given, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual)
    ? "ok"
    : "bad-signature";
}
