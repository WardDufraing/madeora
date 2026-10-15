/**
 * A local stand-in for an S3-compatible object store (S15), for development and the browser tests
 * only: never deployed, never used with real credentials. It keeps objects in memory and checks
 * requests the way S3 and R2 do for what Madeora relies on:
 *
 * - presigned GET and PUT links: signature, expiry and every signed header (so an upload with a
 *   different type or size than the link was signed for is refused);
 * - header-signed server requests (HEAD, GET, PUT, DELETE): signature and body hash;
 * - CORS for the app's origin, so the browser can PUT directly;
 * - the `response-content-type` / `response-content-disposition` / `response-cache-control`
 *   overrides of a presigned GET.
 *
 * Real R2 behaviour (bucket CORS rules, limits) is set up by the owner guide, docs/file-storage.md.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { signRequest, verifyPresignedUrl, type SigningCredentials } from "@madeora/storage";

export interface StandInOptions {
  readonly port: number;
  readonly bucket: string;
  readonly credentials: SigningCredentials;
  /** The web app's origin, allowed to PUT from the browser. */
  readonly allowedOrigin: string;
  /** Largest object accepted, 10 MB by default. */
  readonly maxObjectBytes?: number;
}

interface StoredObject {
  readonly bytes: Buffer;
  readonly contentType: string;
}

export interface S3StandIn {
  readonly url: string;
  readonly objects: ReadonlyMap<string, StoredObject>;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        resolve(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function lowerCaseHeaders(request: IncomingMessage): Map<string, string> {
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name.toLowerCase(), value);
  }
  return headers;
}

/** Checks a header-signed request by signing the same request again at its stated time. */
function verifyHeaderSigned(
  credentials: SigningCredentials,
  method: "GET" | "HEAD" | "PUT" | "DELETE",
  url: string,
  headers: Map<string, string>,
  body: Buffer,
): boolean {
  const authorization = headers.get("authorization");
  const amzDate = headers.get("x-amz-date");
  if (!authorization || !amzDate || !/^\d{8}T\d{6}Z$/.test(amzDate)) return false;
  const signedList = /SignedHeaders=([a-z0-9;-]+)/.exec(authorization)?.[1];
  if (!signedList) return false;
  const signedHeaders: Record<string, string> = {};
  for (const name of signedList.split(";")) {
    if (name === "host" || name === "x-amz-date" || name === "x-amz-content-sha256") continue;
    const value = headers.get(name);
    if (value === undefined) return false;
    signedHeaders[name] = value;
  }
  const at = new Date(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
  );
  if (Math.abs(Date.now() - at.getTime()) > 15 * 60_000) return false;
  const expected = signRequest(credentials, {
    method,
    url,
    headers: signedHeaders,
    body: new Uint8Array(body),
    now: at,
  });
  return (
    headers.get("x-amz-content-sha256") === createHash("sha256").update(body).digest("hex") &&
    sameText(expected.authorization ?? "", authorization)
  );
}

export function startS3StandIn(options: StandInOptions): Promise<S3StandIn> {
  const objects = new Map<string, StoredObject>();
  const maxBytes = options.maxObjectBytes ?? 10 * 1024 * 1024;
  const prefix = `/${options.bucket}/`;

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const origin = request.headers.origin;
    if (origin === options.allowedOrigin) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "origin");
    }
    if (request.method === "OPTIONS") {
      if (origin === options.allowedOrigin) {
        response.setHeader("access-control-allow-methods", "GET, PUT");
        response.setHeader("access-control-allow-headers", "content-type");
        response.setHeader("access-control-max-age", "600");
      }
      response.writeHead(origin === options.allowedOrigin ? 204 : 403).end();
      return;
    }
    const host = request.headers.host ?? `127.0.0.1:${String(options.port)}`;
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (!url.pathname.startsWith(prefix)) {
      response.writeHead(404).end();
      return;
    }
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    const method = request.method;
    if (method !== "GET" && method !== "HEAD" && method !== "PUT" && method !== "DELETE") {
      response.writeHead(405).end();
      return;
    }
    const headers = lowerCaseHeaders(request);
    const body = method === "PUT" ? await readBody(request, maxBytes) : Buffer.alloc(0);
    if (body === null) {
      response.writeHead(413).end();
      return;
    }

    const presigned = url.searchParams.has("X-Amz-Signature");
    if (presigned) {
      if (method !== "GET" && method !== "PUT") {
        response.writeHead(403).end();
        return;
      }
      const verdict = verifyPresignedUrl(options.credentials, {
        method,
        url: url.toString(),
        headers,
        now: new Date(),
      });
      if (verdict !== "ok") {
        response.writeHead(403, { "content-type": "text/plain" }).end(verdict);
        return;
      }
      // S3 checks a signed content-length against the body it received.
      if (method === "PUT" && headers.get("content-length") !== String(body.byteLength)) {
        response.writeHead(400).end();
        return;
      }
    } else if (!verifyHeaderSigned(options.credentials, method, url.toString(), headers, body)) {
      response.writeHead(403).end();
      return;
    }

    if (method === "PUT") {
      objects.set(key, {
        bytes: body,
        contentType: headers.get("content-type") ?? "application/octet-stream",
      });
      response.writeHead(200).end();
      return;
    }
    if (method === "DELETE") {
      objects.delete(key);
      response.writeHead(204).end();
      return;
    }
    const object = objects.get(key);
    if (!object) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-length": String(object.bytes.byteLength),
      "content-type": url.searchParams.get("response-content-type") ?? object.contentType,
      ...(url.searchParams.has("response-content-disposition")
        ? { "content-disposition": url.searchParams.get("response-content-disposition") ?? "" }
        : {}),
      ...(url.searchParams.has("response-cache-control")
        ? { "cache-control": url.searchParams.get("response-cache-control") ?? "" }
        : {}),
    });
    response.end(method === "HEAD" ? undefined : object.bytes);
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(options.port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${String(options.port)}`,
        objects,
        close: () =>
          new Promise((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}
