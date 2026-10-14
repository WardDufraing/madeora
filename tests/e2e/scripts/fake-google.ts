// A stand-in for Google's sign-in, used only by the E2E fallback (auth-fallback.ts, brief S08).
//
// Supabase Auth hard-codes Google's issuer, https://accounts.google.com, and reads its OpenID
// configuration from there. This module lets the real Supabase Auth code run a complete Google
// sign-in without Google:
//
// - a throwaway certificate authority and a certificate for accounts.google.com, made with openssl
//   in the run's temporary folder (Supabase Auth trusts it through SSL_CERT_FILE);
// - an HTTPS proxy (Supabase Auth gets HTTPS_PROXY) that answers only accounts.google.com, and
//   only its discovery document, which points everything else at the local server below;
// - a local server with a consent page (pick the Google account by email, or cancel), the token
//   endpoint (signed ID tokens) and the signing keys.
//
// Nothing here is used by the app or in production.
import { execFileSync } from "node:child_process";
import { createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type Socket } from "node:net";
import { join } from "node:path";
import { TLSSocket } from "node:tls";

export const FAKE_GOOGLE_HOST = "accounts.google.com";

export interface FakeGoogleOptions {
  /** A folder that is deleted after the run, for the certificates. */
  readonly workDir: string;
  /** The local consent page, token endpoint and keys. */
  readonly port: number;
  /** The HTTPS proxy Supabase Auth uses to reach accounts.google.com. */
  readonly proxyPort: number;
  /** Supabase Auth's callback; the only address the consent page sends people back to. */
  readonly redirectUri: string;
}

export interface FakeGoogle {
  readonly clientId: string;
  readonly clientSecret: string;
  /** PEM file of the throwaway authority, for SSL_CERT_FILE. */
  readonly caFile: string;
  readonly proxyUrl: string;
  close(): void;
}

interface PendingCode {
  readonly sub: string;
  readonly email: string;
  readonly name: string;
  readonly expiresAt: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signJwt(payload: Record<string, unknown>, key: KeyObject, kid: string): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const body = base64url(JSON.stringify(payload));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${base64url(signer.sign(key))}`;
}

function makeCertificates(workDir: string): { caFile: string; key: string; cert: string } {
  const file = (name: string) => join(workDir, name);
  const openssl = (args: string[]) => {
    execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
  };
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    file("fake-google-ca.key"),
    "-out",
    file("fake-google-ca.pem"),
    "-subj",
    "/CN=Madeora E2E throwaway CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    file("fake-google.key"),
    "-out",
    file("fake-google.csr"),
    "-subj",
    `/CN=${FAKE_GOOGLE_HOST}`,
  ]);
  writeFileSync(
    file("fake-google.ext"),
    `subjectAltName=DNS:${FAKE_GOOGLE_HOST}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n`,
  );
  openssl([
    "x509",
    "-req",
    "-days",
    "1",
    "-in",
    file("fake-google.csr"),
    "-CA",
    file("fake-google-ca.pem"),
    "-CAkey",
    file("fake-google-ca.key"),
    "-CAcreateserial",
    "-out",
    file("fake-google.pem"),
    "-extfile",
    file("fake-google.ext"),
  ]);
  return {
    caFile: file("fake-google-ca.pem"),
    key: readFileSync(file("fake-google.key"), "utf8"),
    cert: readFileSync(file("fake-google.pem"), "utf8"),
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** A Google subject id derived from the email, so the same "Google account" is the same person. */
export function fakeGoogleSubject(email: string): string {
  let hash = 0n;
  for (const char of email.toLowerCase())
    hash = (hash * 131n + BigInt(char.charCodeAt(0))) % 10n ** 20n;
  return `1${hash.toString().padStart(20, "0")}`;
}

export function startFakeGoogle(options: FakeGoogleOptions): Promise<FakeGoogle> {
  const { workDir, port, proxyPort, redirectUri } = options;
  const certificates = makeCertificates(workDir);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomBytes(8).toString("hex");
  const clientId = "madeora-e2e.apps.googleusercontent.test";
  const clientSecret = randomBytes(16).toString("hex");
  const base = `http://127.0.0.1:${String(port)}`;
  const codes = new Map<string, PendingCode>();

  const discovery = {
    issuer: `https://${FAKE_GOOGLE_HOST}`,
    authorization_endpoint: `${base}/o/oauth2/v2/auth`,
    token_endpoint: `${base}/token`,
    userinfo_endpoint: `${base}/userinfo`,
    jwks_uri: `${base}/certs`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "email", "profile"],
  };

  const send = (res: ServerResponse, status: number, type: string, body: string) => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" }).end(body);
  };

  const consentPage = (params: URLSearchParams): string => {
    const hidden = ["redirect_uri", "state"]
      .map(
        (name) =>
          `<input type="hidden" name="${name}" value="${escapeHtml(params.get(name) ?? "")}">`,
      )
      .join("");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Stand-in Google</title></head>
<body><main><h1>Stand-in Google sign-in</h1>
<form method="get" action="/o/oauth2/v2/approve">${hidden}
<label>Google account email <input name="email" type="email" required></label>
<label>Name <input name="name" value="Test Person"></label>
<button type="submit" name="decision" value="allow">Continue</button>
<button type="submit" name="decision" value="deny" formnovalidate>Cancel</button>
</form></main></body></html>`;
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", base);
      if (req.method === "GET" && url.pathname === "/o/oauth2/v2/auth") {
        if (url.searchParams.get("redirect_uri") !== redirectUri) {
          send(res, 400, "text/plain", "redirect_uri not allowed");
          return;
        }
        if (url.searchParams.get("client_id") !== clientId) {
          send(res, 400, "text/plain", "unknown client");
          return;
        }
        send(res, 200, "text/html; charset=utf-8", consentPage(url.searchParams));
        return;
      }
      if (req.method === "GET" && url.pathname === "/o/oauth2/v2/approve") {
        const target = new URL(redirectUri);
        if (url.searchParams.get("redirect_uri") !== redirectUri) {
          send(res, 400, "text/plain", "redirect_uri not allowed");
          return;
        }
        target.searchParams.set("state", url.searchParams.get("state") ?? "");
        if (url.searchParams.get("decision") !== "allow") {
          target.searchParams.set("error", "access_denied");
        } else {
          const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
          const code = randomBytes(16).toString("hex");
          codes.set(code, {
            sub: fakeGoogleSubject(email),
            email,
            name: url.searchParams.get("name") ?? "",
            expiresAt: Date.now() + 60_000,
          });
          target.searchParams.set("code", code);
        }
        res.writeHead(302, { location: target.toString() }).end();
        return;
      }
      if (req.method === "POST" && url.pathname === "/token") {
        const form = new URLSearchParams(await readBody(req));
        const basic = req.headers.authorization?.startsWith("Basic ")
          ? Buffer.from(req.headers.authorization.slice(6), "base64").toString("utf8").split(":")
          : [];
        const id = decodeURIComponent(basic[0] ?? form.get("client_id") ?? "");
        const secret = decodeURIComponent(basic[1] ?? form.get("client_secret") ?? "");
        const code = form.get("code") ?? "";
        const pending = codes.get(code);
        codes.delete(code);
        if (
          id !== clientId ||
          secret !== clientSecret ||
          form.get("grant_type") !== "authorization_code" ||
          form.get("redirect_uri") !== redirectUri ||
          !pending ||
          pending.expiresAt < Date.now()
        ) {
          send(res, 400, "application/json", JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        const idToken = signJwt(
          {
            iss: `https://${FAKE_GOOGLE_HOST}`,
            aud: clientId,
            azp: clientId,
            sub: pending.sub,
            email: pending.email,
            email_verified: true,
            name: pending.name,
            iat: now,
            exp: now + 300,
          },
          privateKey,
          kid,
        );
        send(
          res,
          200,
          "application/json",
          JSON.stringify({
            access_token: randomBytes(16).toString("hex"),
            token_type: "Bearer",
            expires_in: 300,
            id_token: idToken,
          }),
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/certs") {
        const jwk = publicKey.export({ format: "jwk" });
        send(
          res,
          200,
          "application/json",
          JSON.stringify({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }),
        );
        return;
      }
      send(res, 404, "text/plain", "not found");
    })().catch(() => {
      if (!res.headersSent) send(res, 500, "text/plain", "error");
    });
  });

  // accounts.google.com, reached through the proxy: only the discovery document.
  const googleSite = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/openid-configuration") {
      send(res, 200, "application/json", JSON.stringify(discovery));
      return;
    }
    send(res, 404, "text/plain", "not found");
  });

  // Plain HTTP requests through the proxy are refused; CONNECT is allowed to accounts.google.com only.
  const proxy = createServer((_req, res) => {
    send(res, 403, "text/plain", "only CONNECT to accounts.google.com");
  });
  proxy.on("connect", (req: IncomingMessage, socket: Socket) => {
    if (req.url !== `${FAKE_GOOGLE_HOST}:443`) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n", () => {
      const tls = new TLSSocket(socket, {
        isServer: true,
        key: certificates.key,
        cert: certificates.cert,
      });
      googleSite.emit("connection", tls);
    });
  });

  const listen = (s: Server, p: number) =>
    new Promise<void>((done) => {
      s.listen(p, "127.0.0.1", () => {
        done();
      });
    });

  return Promise.all([listen(server, port), listen(proxy, proxyPort)]).then(() => ({
    clientId,
    clientSecret,
    caFile: certificates.caFile,
    proxyUrl: `http://127.0.0.1:${String(proxyPort)}`,
    close() {
      server.close();
      proxy.close();
      googleSite.close();
    },
  }));
}
