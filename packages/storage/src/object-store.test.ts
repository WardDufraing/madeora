import { describe, expect, it, vi } from "vitest";

import { parseStorageEnv, storageConfigFromEnv } from "./config.ts";
import { StorageUnavailableError, createObjectStore } from "./object-store.ts";

const key = `u/${"c".repeat(64)}`;
const config = {
  endpoint: "https://account.r2.example",
  region: "auto",
  bucket: "madeora-dev",
  accessKeyId: "a".repeat(32),
  secretAccessKey: "s".repeat(64),
};
const now = () => new Date("2026-10-15T12:00:00Z");

function storeWith(response: () => Response) {
  const fetchMock = vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve(response()),
  );
  return { store: createObjectStore(config, { fetch: fetchMock, now }), fetchMock };
}

describe("createObjectStore", () => {
  it("refuses keys the database did not generate", () => {
    const { store } = storeWith(() => new Response(null));
    for (const forged of ["../etc/passwd", "u/abc", `x/${"c".repeat(64)}`, `${key}/extra`]) {
      expect(() =>
        store.presignGet(forged, {
          expiresInSeconds: 60,
          contentType: "image/webp",
          disposition: "inline",
        }),
      ).toThrow(TypeError);
    }
  });

  it("presigns an upload bound to its type and size, and tells the browser the headers to send", () => {
    const { store } = storeWith(() => new Response(null));
    const upload = store.presignPut(key, {
      contentType: "image/png",
      contentLength: 1234,
      expiresInSeconds: 300,
    });
    const url = new URL(upload.url);
    expect(url.origin + url.pathname).toBe(`https://account.r2.example/madeora-dev/${key}`);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(upload.headers).toEqual({ "content-type": "image/png" });
  });

  it("presigns a download that fixes type, disposition and caching", () => {
    const { store } = storeWith(() => new Response(null));
    const url = new URL(
      store.presignGet(key, {
        expiresInSeconds: 60,
        contentType: "image/webp",
        disposition: "inline",
      }),
    );
    expect(url.searchParams.get("response-content-type")).toBe("image/webp");
    expect(url.searchParams.get("response-content-disposition")).toBe("inline");
    expect(url.searchParams.get("response-cache-control")).toBe("private, no-store");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
  });

  it("reads facts with HEAD and treats a missing object as null", async () => {
    const found = storeWith(
      () =>
        new Response(null, { headers: { "content-length": "42", "content-type": "image/png" } }),
    );
    await expect(found.store.head(key)).resolves.toEqual({ size: 42, contentType: "image/png" });
    const init = found.fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("HEAD");
    expect((init?.headers as Record<string, string>).authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    const missing = storeWith(() => new Response(null, { status: 404 }));
    await expect(missing.store.head(key)).resolves.toBeNull();
  });

  it("stops reading past the byte limit", async () => {
    const big = storeWith(() => new Response(new Uint8Array(2000)));
    await expect(big.store.get(key, 1000)).resolves.toEqual({ status: "too-large" });
    const declared = storeWith(
      () => new Response(new Uint8Array(10), { headers: { "content-length": "5000" } }),
    );
    await expect(declared.store.get(key, 1000)).resolves.toEqual({ status: "too-large" });
    const small = storeWith(() => new Response(new Uint8Array([1, 2, 3])));
    const read = await small.store.get(key, 1000);
    expect(read.status === "ok" && [...read.bytes]).toEqual([1, 2, 3]);
  });

  it("counts an object already gone as deleted, and reports outages with a code only", async () => {
    await expect(
      storeWith(() => new Response(null, { status: 404 })).store.delete(key),
    ).resolves.toBe(undefined);
    const down = storeWith(() => new Response("internal details", { status: 503 }));
    await expect(down.store.delete(key)).rejects.toThrow(StorageUnavailableError);
    await expect(down.store.delete(key)).rejects.toMatchObject({ code: "status_503" });
    const unreachable = createObjectStore(config, {
      fetch: () => Promise.reject(new Error("ECONNREFUSED with secrets")),
      now,
    });
    await expect(unreachable.head(key)).rejects.toMatchObject({ code: "network" });
  });

  it("puts bytes with a signed body hash", async () => {
    const { store, fetchMock } = storeWith(() => new Response(null));
    await store.put(key, new Uint8Array([9, 9]), "image/webp");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("PUT");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("image/webp");
  });
});

describe("storage settings", () => {
  it("is off unless configured", () => {
    expect(storageConfigFromEnv(parseStorageEnv({}))).toBeNull();
    expect(storageConfigFromEnv(parseStorageEnv({ STORAGE_DRIVER: "off" }))).toBeNull();
  });

  it("requires every S3 value when on, naming variables but never values", () => {
    expect(() => parseStorageEnv({ STORAGE_DRIVER: "s3" })).toThrow(/STORAGE_S3_ENDPOINT/);
    try {
      parseStorageEnv({
        STORAGE_DRIVER: "s3",
        STORAGE_S3_ENDPOINT: "https://x.example",
        STORAGE_S3_BUCKET: "b-1",
        STORAGE_S3_ACCESS_KEY_ID: "short",
        STORAGE_S3_SECRET_ACCESS_KEY: "s".repeat(40),
      });
    } catch (error) {
      expect(String(error)).toContain("STORAGE_S3_ACCESS_KEY_ID");
      expect(String(error)).not.toContain("short");
    }
  });

  it("allows plain http only on this machine", () => {
    const base = {
      STORAGE_DRIVER: "s3",
      STORAGE_S3_BUCKET: "madeora",
      STORAGE_S3_ACCESS_KEY_ID: "a".repeat(20),
      STORAGE_S3_SECRET_ACCESS_KEY: "s".repeat(40),
    };
    expect(
      storageConfigFromEnv(
        parseStorageEnv({ ...base, STORAGE_S3_ENDPOINT: "http://127.0.0.1:9100/" }),
      ),
    ).toMatchObject({ endpoint: "http://127.0.0.1:9100", region: "auto" });
    expect(() => parseStorageEnv({ ...base, STORAGE_S3_ENDPOINT: "http://store.example" })).toThrow(
      /STORAGE_S3_ENDPOINT/,
    );
  });
});
