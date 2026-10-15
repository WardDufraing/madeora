/**
 * The S3-compatible object store behind Madeora's private files (S15, architecture.md §10): signed
 * upload and download links for browsers, and HEAD/GET/PUT/DELETE for the server and the jobs.
 * Path-style addressing (`<endpoint>/<bucket>/<key>`), which R2 supports. Keys are always the
 * opaque ones the database generated; this module refuses anything else.
 *
 * Server only. Signed URLs and credentials are never logged; errors carry short codes only.
 */
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import type { StorageConfig } from "./config.ts";
import { presignUrl, signRequest, uriEncode, type SigningCredentials } from "./sigv4.ts";

/** The only keys Madeora stores: a namespace letter and 256 random bits in hex. */
export const OBJECT_KEY = /^(u|h)\/[0-9a-f]{64}$/;

/** The store could not be reached or refused the request; `code` is safe to log. */
export class StorageUnavailableError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`object storage unavailable: ${code}`);
    this.name = "StorageUnavailableError";
    this.code = code;
  }
}

export interface PresignedUpload {
  readonly url: string;
  /** Headers the browser must send unchanged: they are part of the signature. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface ObjectFacts {
  readonly size: number;
  readonly contentType: string | null;
}

export type ObjectRead =
  | { readonly status: "ok"; readonly bytes: Uint8Array; readonly contentType: string | null }
  | { readonly status: "missing" }
  | { readonly status: "too-large" };

export interface ObjectStore {
  presignPut(
    key: string,
    options: {
      readonly contentType: string;
      readonly contentLength: number;
      readonly expiresInSeconds: number;
    },
  ): PresignedUpload;
  presignGet(
    key: string,
    options: {
      readonly expiresInSeconds: number;
      readonly contentType: string;
      readonly disposition: "inline" | "attachment";
    },
  ): string;
  head(key: string): Promise<ObjectFacts | null>;
  /** Reads at most `maxBytes`; a larger object is `too-large` and is not read further. */
  get(key: string, maxBytes: number): Promise<ObjectRead>;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Removes an object; one that is already gone counts as removed. */
  delete(key: string): Promise<void>;
}

export interface ObjectStoreOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  /** Per-request time limit, 10 seconds by default. */
  readonly timeoutMs?: number;
}

function checkKey(key: string): void {
  if (!OBJECT_KEY.test(key)) throw new TypeError("not a Madeora object key");
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
  const reader = (response.body as unknown as WebReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const value = chunk.value;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createObjectStore(
  config: StorageConfig,
  options: ObjectStoreOptions = {},
): ObjectStore {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 10_000;
  const credentials: SigningCredentials = {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
  };
  const objectUrl = (key: string) => {
    checkKey(key);
    return `${config.endpoint}/${uriEncode(config.bucket)}/${key}`;
  };

  async function send(
    method: "GET" | "HEAD" | "PUT" | "DELETE",
    key: string,
    extra: { readonly headers?: Record<string, string>; readonly body?: Uint8Array } = {},
  ): Promise<Response> {
    const url = objectUrl(key);
    const headers = signRequest(credentials, {
      method,
      url,
      now: now(),
      ...(extra.headers ? { headers: extra.headers } : {}),
      ...(extra.body ? { body: extra.body } : {}),
    });
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
        ...(extra.body ? { body: new Blob([extra.body.slice()]) } : {}),
      });
    } catch {
      throw new StorageUnavailableError("network");
    }
    if (response.status >= 500)
      throw new StorageUnavailableError(`status_${String(response.status)}`);
    return response;
  }

  return {
    presignPut(key, { contentType, contentLength, expiresInSeconds }) {
      if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
        throw new RangeError("contentLength must be a positive integer");
      }
      const headers = { "content-type": contentType, "content-length": String(contentLength) };
      return {
        url: presignUrl(credentials, {
          method: "PUT",
          url: objectUrl(key),
          expiresInSeconds,
          signedHeaders: headers,
          now: now(),
        }),
        // The browser sets content-length itself from the body; it must match the signed value.
        headers: { "content-type": contentType },
      };
    },

    presignGet(key, { expiresInSeconds, contentType, disposition }) {
      const url = new URL(objectUrl(key));
      // Signed into the link, so the store serves exactly this type and disposition.
      url.searchParams.set("response-content-type", contentType);
      url.searchParams.set("response-content-disposition", disposition);
      url.searchParams.set("response-cache-control", "private, no-store");
      return presignUrl(credentials, {
        method: "GET",
        url: url.toString(),
        expiresInSeconds,
        now: now(),
      });
    },

    async head(key) {
      const response = await send("HEAD", key);
      if (response.status === 404) return null;
      if (!response.ok) throw new StorageUnavailableError(`status_${String(response.status)}`);
      const size = Number(response.headers.get("content-length"));
      if (!Number.isSafeInteger(size) || size < 0) throw new StorageUnavailableError("bad_length");
      return { size, contentType: response.headers.get("content-type") };
    },

    async get(key, maxBytes) {
      const response = await send("GET", key);
      if (response.status === 404) {
        await response.body?.cancel();
        return { status: "missing" };
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new StorageUnavailableError(`status_${String(response.status)}`);
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > maxBytes) {
        await response.body?.cancel();
        return { status: "too-large" };
      }
      const bytes = await readLimited(response, maxBytes);
      if (!bytes) return { status: "too-large" };
      return { status: "ok", bytes, contentType: response.headers.get("content-type") };
    },

    async put(key, bytes, contentType) {
      const response = await send("PUT", key, {
        headers: { "content-type": contentType },
        body: bytes,
      });
      await response.body?.cancel();
      if (!response.ok) throw new StorageUnavailableError(`status_${String(response.status)}`);
    },

    async delete(key) {
      const response = await send("DELETE", key);
      await response.body?.cancel();
      if (!response.ok && response.status !== 404) {
        throw new StorageUnavailableError(`status_${String(response.status)}`);
      }
    },
  };
}
