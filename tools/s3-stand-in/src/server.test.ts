import { createObjectStore } from "@madeora/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startS3StandIn, type S3StandIn } from "./server.ts";

// The object store client and the stand-in together, over real HTTP: what the browser tests rely on.
const credentials = {
  accessKeyId: "a".repeat(20),
  secretAccessKey: "s".repeat(40),
  region: "auto",
};
const origin = "http://127.0.0.1:3999";
const key = `u/${"d".repeat(64)}`;
let standIn: S3StandIn;

beforeAll(async () => {
  standIn = await startS3StandIn({
    port: 54391,
    bucket: "madeora-test",
    credentials,
    allowedOrigin: origin,
  });
});
afterAll(async () => {
  await standIn.close();
});

function store(secretAccessKey = credentials.secretAccessKey) {
  return createObjectStore({
    endpoint: standIn.url,
    region: "auto",
    bucket: "madeora-test",
    accessKeyId: credentials.accessKeyId,
    secretAccessKey,
  });
}

describe("S3 stand-in", () => {
  it("accepts a browser upload only with the signed type and size", async () => {
    const upload = store().presignPut(key, {
      contentType: "image/png",
      contentLength: 4,
      expiresInSeconds: 60,
    });
    const wrongSize = await fetch(upload.url, {
      method: "PUT",
      headers: upload.headers,
      body: new Uint8Array([1, 2, 3, 4, 5]),
    });
    expect(wrongSize.status).toBe(403);
    const wrongType = await fetch(upload.url, {
      method: "PUT",
      headers: { "content-type": "text/html" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(wrongType.status).toBe(403);
    const ok = await fetch(upload.url, {
      method: "PUT",
      headers: upload.headers,
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(ok.status).toBe(200);
    await expect(store().head(key)).resolves.toEqual({ size: 4, contentType: "image/png" });
  });

  it("serves a presigned download with the signed overrides, and refuses a tampered link", async () => {
    const url = store().presignGet(key, {
      expiresInSeconds: 60,
      contentType: "image/webp",
      disposition: "inline",
    });
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const tampered = await fetch(url.replace("image%2Fwebp", "text%2Fhtml"));
    expect(tampered.status).toBe(403);
    const otherKey = await fetch(url.replace("d".repeat(64), "e".repeat(64)));
    expect(otherKey.status).toBe(403);
  });

  it("refuses server requests signed with another secret", async () => {
    await expect(store("x".repeat(40)).head(key)).rejects.toMatchObject({ code: "status_403" });
  });

  it("puts, reads with a limit, and deletes", async () => {
    await store().put(key, new Uint8Array(100), "image/webp");
    await expect(store().get(key, 50)).resolves.toEqual({ status: "too-large" });
    const read = await store().get(key, 200);
    expect(read.status === "ok" && read.bytes.byteLength).toBe(100);
    await store().delete(key);
    await expect(store().head(key)).resolves.toBeNull();
    await expect(store().delete(key)).resolves.toBeUndefined();
  });

  it("answers CORS only for the app's origin", async () => {
    const allowed = await fetch(`${standIn.url}/madeora-test/${key}`, {
      method: "OPTIONS",
      headers: { origin },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(origin);
    const other = await fetch(`${standIn.url}/madeora-test/${key}`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(other.status).toBe(403);
  });
});
