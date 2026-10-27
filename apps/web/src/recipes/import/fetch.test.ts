import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

import { fetchRecipePage, importableUrl, type FetchOptions } from "./fetch";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

let server: Server;
let port = 0;
let handler: Handler = (_request, response) => response.end();
const seen: IncomingMessage[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push(request);
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
});

beforeEach(() => {
  seen.length = 0;
});

const page =
  '<html><script type="application/ld+json">{"@type":"Recipe","name":"Soup"}</script></html>';

function html(body = page, extra: Record<string, string> = {}): Handler {
  return (_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...extra });
    response.end(body);
  };
}

/** The local test server stands in for a public site: only 127.0.0.1 and its port are allowed. */
function local(overrides: FetchOptions = {}): FetchOptions {
  return {
    isAllowedAddress: (address) => address === "127.0.0.1",
    allowedPorts: [port],
    ...overrides,
  };
}

const at = (path = "/") => `http://127.0.0.1:${String(port)}${path}`;

describe("importableUrl", () => {
  it.each([
    "https://example.com/recipe",
    "http://example.com/recipe",
    "https://example.com:443/recipe",
    "http://example.com:80/recipe",
  ])("accepts %s", (url) => {
    expect(importableUrl(url)).not.toBeNull();
  });

  it.each([
    "ftp://example.com/recipe",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hi",
    "https://user:secret@example.com/",
    "https://user@example.com/",
    "https://example.com:8080/",
    "http://example.com:22/",
    "not a url",
    `https://example.com/${"a".repeat(2000)}`,
  ])("refuses %s", (url) => {
    expect(importableUrl(url)).toBeNull();
  });

  it("drops the fragment", () => {
    expect(importableUrl("https://example.com/r#step-2")?.href).toBe("https://example.com/r");
  });
});

describe("fetchRecipePage", () => {
  it("refuses loopback, private and metadata addresses with the real address check", async () => {
    handler = html();
    for (const url of [
      at(),
      `http://127.0.0.1/`,
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      // The test server's port is allowed, so only the address check can refuse the first one.
      expect(await fetchRecipePage(url, { allowedPorts: [80, port] })).toEqual({
        ok: false,
        reason: "blocked",
      });
    }
    expect(seen).toHaveLength(0);
  });

  it("refuses a host name when any of its addresses is not public", async () => {
    const resolve = () =>
      Promise.resolve([
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]);
    expect(await fetchRecipePage("http://recipes.example/", { resolve })).toEqual({
      ok: false,
      reason: "blocked",
    });
  });

  it("connects to the checked address without looking the name up again", async () => {
    handler = html();
    let lookups = 0;
    const resolve = () => {
      lookups += 1;
      return Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
    };
    // "recipes.invalid" never resolves in real DNS: the request only works through the pinned address.
    const result = await fetchRecipePage(
      `http://recipes.invalid:${String(port)}/r`,
      local({ resolve }),
    );
    expect(result).toEqual({
      ok: true,
      url: `http://recipes.invalid:${String(port)}/r`,
      body: page,
    });
    expect(lookups).toBe(1);
    expect(seen[0]?.headers.host).toBe(`recipes.invalid:${String(port)}`);
  });

  it("sends no cookies, credentials or Referer", async () => {
    handler = html();
    await fetchRecipePage(at(), local());
    const headers = seen[0]?.headers ?? {};
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers.referer).toBeUndefined();
    expect(headers["user-agent"]).toMatch(/^MadeoraRecipeImport\//);
  });

  it("follows a redirect and checks the new address", async () => {
    handler = (request, response) => {
      if (request.url === "/old") {
        response.writeHead(301, { location: "/new" });
        response.end();
        return;
      }
      html()(request, response);
    };
    expect(await fetchRecipePage(at("/old"), local())).toEqual({
      ok: true,
      url: at("/new"),
      body: page,
    });
  });

  it.each([
    ["a private address", "http://127.0.0.2/admin"],
    ["the metadata service", "http://169.254.169.254/latest/meta-data/"],
    ["an IPv6 loopback", "http://[::1]/"],
    ["another scheme", "file:///etc/passwd"],
    ["another port", "http://127.0.0.1:6379/"],
    ["user info", "http://admin:pw@127.0.0.1/"],
  ])("refuses a redirect to %s", async (_label, location) => {
    handler = (_request, response) => {
      response.writeHead(302, { location });
      response.end();
    };
    expect(await fetchRecipePage(at(), local())).toEqual({ ok: false, reason: "blocked" });
    expect(seen).toHaveLength(1);
  });

  it("stops after three redirects", async () => {
    handler = (request, response) => {
      const hop = Number(request.url?.slice(1) ?? "0");
      response.writeHead(302, { location: `/${String(hop + 1)}` });
      response.end();
    };
    expect(await fetchRecipePage(at("/0"), local())).toEqual({ ok: false, reason: "unreachable" });
    expect(seen).toHaveLength(4);
  });

  it("gives up after the time limit", async () => {
    handler = () => {
      // Never answers.
    };
    expect(await fetchRecipePage(at(), local({ timeoutMs: 150 }))).toEqual({
      ok: false,
      reason: "timeout",
    });
  });

  it("refuses a page over the size limit, declared or not", async () => {
    handler = html("x".repeat(500));
    expect(await fetchRecipePage(at(), local({ maxBytes: 100 }))).toEqual({
      ok: false,
      reason: "too_large",
    });
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.write("x".repeat(80));
      response.end("x".repeat(80));
    };
    expect(await fetchRecipePage(at(), local({ maxBytes: 100 }))).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("counts the decompressed size", async () => {
    const big = gzipSync(Buffer.from("x".repeat(10_000)));
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      response.end(big);
    };
    expect(await fetchRecipePage(at(), local({ maxBytes: 5_000 }))).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it.each(["gzip", "identity"])(
    "says unreachable at once when a %s page is cut off mid-body",
    async (encoding) => {
      const full =
        encoding === "gzip"
          ? gzipSync(Buffer.from(page.repeat(200)))
          : Buffer.from(page.repeat(200));
      handler = (_request, response) => {
        response.writeHead(200, {
          "content-type": "text/html",
          "content-length": String(full.length),
          ...(encoding === "gzip" ? { "content-encoding": "gzip" } : {}),
        });
        response.write(full.subarray(0, 100));
        setTimeout(() => response.socket?.destroy(), 20);
      };
      const started = performance.now();
      expect(await fetchRecipePage(at(), local({ timeoutMs: 5_000 }))).toEqual({
        ok: false,
        reason: "unreachable",
      });
      expect(performance.now() - started).toBeLessThan(2_000);
    },
  );

  it("reads a compressed page", async () => {
    handler = (_request, response) => {
      response.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      response.end(gzipSync(Buffer.from(page)));
    };
    expect(await fetchRecipePage(at(), local())).toEqual({ ok: true, url: at(), body: page });
  });

  it.each(["application/json", "image/png", "application/octet-stream", ""])(
    "refuses content of type %j",
    async (type) => {
      handler = (_request, response) => {
        response.writeHead(200, type === "" ? {} : { "content-type": type });
        response.end("{}");
      };
      expect(await fetchRecipePage(at(), local())).toEqual({ ok: false, reason: "not_html" });
    },
  );

  it.each([
    [401, "restricted"],
    [403, "restricted"],
    [404, "not_found"],
    [410, "not_found"],
    [500, "unreachable"],
  ] as const)("says why for status %i", async (status, reason) => {
    handler = (_request, response) => {
      response.writeHead(status, { "content-type": "text/html" });
      response.end("no");
    };
    expect(await fetchRecipePage(at(), local())).toEqual({ ok: false, reason });
  });

  it("says unreachable when nothing listens or the name does not resolve", async () => {
    expect(await fetchRecipePage("http://127.0.0.1:1/", local({ allowedPorts: [1] }))).toEqual({
      ok: false,
      reason: "unreachable",
    });
    const resolve = () => Promise.reject(new Error("ENOTFOUND"));
    expect(await fetchRecipePage("https://nowhere.example/", { resolve })).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
});
