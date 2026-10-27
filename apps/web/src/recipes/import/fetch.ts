import "server-only";

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, type Readable, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import { isPublicAddress } from "./address";

/**
 * Fetches one web page for a recipe import, from the server only (S25, ARCH §38). SSRF protection:
 * http(s) URLs on the default ports without user info; the host is resolved once and every address
 * must be public (./address.ts); the connection goes to the checked address (no second lookup, so
 * no DNS rebinding); redirects are followed by hand, each checked the same way. Strict limits on
 * time and size, no cookies, no credentials, no Referer. The page is returned as text for the
 * extractor and never interpreted here.
 */

export type FetchFailure =
  | "invalid_url"
  | "blocked"
  | "unreachable"
  | "timeout"
  | "too_large"
  | "not_html"
  | "restricted"
  | "not_found";

export type FetchResult =
  | { readonly ok: true; readonly url: string; readonly body: string }
  | { readonly ok: false; readonly reason: FetchFailure };

export interface FetchOptions {
  /** Everything, redirects included, must finish within this time. */
  readonly timeoutMs?: number;
  /** The most bytes read from a page (after decompression). */
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  /** For tests only: how a host name resolves, and which addresses and ports are allowed. */
  readonly resolve?: (host: string) => Promise<readonly { address: string; family: number }[]>;
  readonly isAllowedAddress?: (address: string) => boolean;
  readonly allowedPorts?: readonly number[];
}

export const IMPORT_LIMITS = {
  timeoutMs: 10_000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 3,
  urlLength: 2000,
} as const;

const USER_AGENT = "MadeoraRecipeImport/1.0 (+https://madeora.studio)";
const PAGE_TYPES = ["text/html", "application/xhtml+xml", "application/ld+json"];

class Refused extends Error {
  constructor(readonly reason: FetchFailure) {
    super(reason);
  }
}

function defaultResolve(host: string) {
  return dnsLookup(host, { all: true, verbatim: true });
}

/** The URL if an import may ask for it at all (scheme, length, user info, port), otherwise null. */
export function importableUrl(input: string, allowedPorts?: readonly number[]): URL | null {
  if (input.length > IMPORT_LIMITS.urlLength) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.hostname === "") return null;
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (
    allowedPorts ? !allowedPorts.includes(port) : url.port !== "" && port !== 80 && port !== 443
  ) {
    return null;
  }
  url.hash = "";
  return url;
}

/** The one address to connect to, after checking every address the host has. */
async function checkedAddress(
  url: URL,
  options: FetchOptions,
): Promise<{ address: string; family: number }> {
  const allowed = options.isAllowedAddress ?? isPublicAddress;
  // URL keeps IPv6 literals in brackets.
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (isIP(host) !== 0) {
    if (!allowed(host)) throw new Refused("blocked");
    return { address: host, family: isIP(host) };
  }
  let addresses: readonly { address: string; family: number }[];
  try {
    addresses = await (options.resolve ?? defaultResolve)(host);
  } catch {
    throw new Refused("unreachable");
  }
  const first = addresses[0];
  if (!first) throw new Refused("unreachable");
  // One blocked address is enough to refuse: the host could answer with it next time.
  if (addresses.some(({ address }) => !allowed(address))) throw new Refused("blocked");
  return first;
}

function decoder(response: IncomingMessage): Transform | null {
  switch ((response.headers["content-encoding"] ?? "identity").toLowerCase()) {
    case "identity":
      return null;
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      throw new Refused("unreachable");
  }
}

/** The body, decompressed; an error on the connection reaches the result (pipe would drop it). */
function decoded(response: IncomingMessage): Readable {
  const transform = decoder(response);
  if (!transform) return response;
  pipeline(response, transform, () => undefined);
  return transform;
}

function charsetOf(contentType: string): string {
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  const charset = match?.[1]?.toLowerCase() ?? "utf-8";
  try {
    new TextDecoder(charset);
    return charset;
  } catch {
    return "utf-8";
  }
}

interface Hop {
  readonly status: number;
  readonly location: string | null;
  readonly body: string | null;
}

function requestOnce(
  url: URL,
  target: { address: string; family: number },
  options: FetchOptions,
  signal: AbortSignal,
) {
  const maxBytes = options.maxBytes ?? IMPORT_LIMITS.maxBytes;
  // Every connection goes to the address that was checked: the name is never looked up again.
  const pinned: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<Hop>((resolve, reject) => {
    const outgoing = send(
      url,
      {
        method: "GET",
        lookup: pinned,
        // A fresh connection every time: a pooled socket could skip the address just checked.
        agent: false,
        signal,
        // No cookies, credentials or Referer are ever sent; nothing about the person or their Home.
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml;q=0.9,application/ld+json;q=0.8",
          "accept-encoding": "gzip, deflate, br",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          resolve({ status, location: response.headers.location ?? null, body: null });
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          resolve({ status, location: null, body: null });
          return;
        }
        const contentType = (response.headers["content-type"] ?? "").toLowerCase();
        if (!PAGE_TYPES.some((type) => contentType.startsWith(type))) {
          response.destroy();
          reject(new Refused("not_html"));
          return;
        }
        const declared = Number(response.headers["content-length"] ?? "0");
        if (declared > maxBytes) {
          response.destroy();
          reject(new Refused("too_large"));
          return;
        }
        let stream: Readable;
        try {
          stream = decoded(response);
        } catch (error) {
          response.destroy();
          reject(error instanceof Error ? error : new Refused("unreachable"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            stream.destroy();
            reject(new Refused("too_large"));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => {
          const text = new TextDecoder(charsetOf(contentType)).decode(Buffer.concat(chunks));
          resolve({ status, location: null, body: text });
        });
        stream.on("error", () => {
          reject(new Refused(signal.aborted ? "timeout" : "unreachable"));
        });
      },
    );
    outgoing.on("error", () => {
      reject(new Refused(signal.aborted ? "timeout" : "unreachable"));
    });
    outgoing.end();
  });
}

/** Fetches the page at `input` for an import, or says why not. Never throws. */
export async function fetchRecipePage(
  input: string,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? IMPORT_LIMITS.timeoutMs);
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(new Refused("timeout"));
    });
  });
  // Once the fetch is over, the final abort rejects this too: nobody is waiting for it then.
  deadline.catch(() => undefined);
  try {
    let url = importableUrl(input, options.allowedPorts);
    if (!url) return { ok: false, reason: "invalid_url" };
    const maxRedirects = options.maxRedirects ?? IMPORT_LIMITS.maxRedirects;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const target = await Promise.race([checkedAddress(url, options), deadline]);
      const answer = await Promise.race([
        requestOnce(url, target, options, controller.signal),
        deadline,
      ]);
      if (answer.body !== null) return { ok: true, url: url.href, body: answer.body };
      if (answer.status >= 300 && answer.status < 400) {
        if (!answer.location) return { ok: false, reason: "unreachable" };
        // Each redirect is a new request: the same URL rules and address checks apply.
        let next: URL;
        try {
          next = new URL(answer.location, url);
        } catch {
          return { ok: false, reason: "invalid_url" };
        }
        const checked = importableUrl(next.href, options.allowedPorts);
        if (!checked) return { ok: false, reason: "blocked" };
        url = checked;
        continue;
      }
      if (answer.status === 401 || answer.status === 402 || answer.status === 403) {
        return { ok: false, reason: "restricted" };
      }
      if (answer.status === 404 || answer.status === 410) return { ok: false, reason: "not_found" };
      return { ok: false, reason: "unreachable" };
    }
    return { ok: false, reason: "unreachable" };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason };
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
