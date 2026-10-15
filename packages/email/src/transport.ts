/**
 * Delivery of rendered emails (CLAUDE.md email strategy A). Server-only by use: a transport holds
 * the provider's API key, so only server code creates one (apps/web/src/email/send.ts).
 *
 * - Resend's HTTP API for hosted environments, with an idempotency key so a retried request never
 *   sends the same email twice.
 * - Mailpit, the local mail catcher of the Supabase CLI stack and the test fallback, for
 *   development and tests only: nothing leaves the machine.
 *
 * Nothing here logs addresses, subjects or bodies; callers log the outcome only.
 */

export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** Same key, same email: the provider sends it at most once (Resend keeps keys for 24 hours). */
  readonly idempotencyKey: string;
}

export type SendResult =
  | { readonly ok: true }
  /** `rejected`: the provider refused this email (address, sender or key); `unavailable`: the
   * provider could not be reached or failed, so trying again later may work. */
  | { readonly ok: false; readonly reason: "rejected" | "unavailable"; readonly status?: number };

export interface EmailTransport {
  send(email: OutgoingEmail): Promise<SendResult>;
}

type Fetch = typeof fetch;

const TIMEOUT_MS = 10_000;

async function post(
  fetchImpl: Fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<SendResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  // The body may contain the address; it is read only to free the connection.
  await response.body?.cancel().catch(() => undefined);
  if (response.ok) return { ok: true };
  // 409 is Resend saying another request with the same idempotency key is still in flight: the
  // email may yet be sent, so trying again later is right (and safe, with the same key).
  const reason =
    response.status === 429 || response.status === 409 || response.status >= 500
      ? "unavailable"
      : "rejected";
  return { ok: false, reason, status: response.status };
}

export interface ResendTransportOptions {
  readonly apiKey: string;
  /** `Madeora <no-reply@mail.madeora.studio>` */
  readonly from: string;
  readonly fetch?: Fetch;
}

/** Sends through Resend's API (https://resend.com/docs/api-reference/emails/send-email). */
export function createResendTransport(options: ResendTransportOptions): EmailTransport {
  const fetchImpl = options.fetch ?? fetch;
  return {
    send: (email) =>
      post(
        fetchImpl,
        "https://api.resend.com/emails",
        {
          authorization: `Bearer ${options.apiKey}`,
          "idempotency-key": email.idempotencyKey,
        },
        {
          from: options.from,
          to: [email.to],
          subject: email.subject,
          html: email.html,
          text: email.text,
        },
      ),
  };
}

export interface MailpitTransportOptions {
  /** Mailpit's web address, for example `http://127.0.0.1:54324`. */
  readonly url: string;
  readonly from: string;
  readonly fetch?: Fetch;
}

/** Splits `Name <address>` into its parts (Mailpit wants them separately). */
function parseSender(from: string): { Email: string; Name?: string } {
  const match = /^\s*(.*?)\s*<([^<>\s]+)>\s*$/.exec(from);
  if (!match?.[2]) return { Email: from.trim() };
  return match[1] ? { Email: match[2], Name: match[1] } : { Email: match[2] };
}

/** Delivers into a local Mailpit through its send API (development and tests only). */
export function createMailpitTransport(options: MailpitTransportOptions): EmailTransport {
  const fetchImpl = options.fetch ?? fetch;
  const endpoint = new URL("/api/v1/send", options.url).toString();
  return {
    send: (email) =>
      post(
        fetchImpl,
        endpoint,
        {},
        {
          From: parseSender(options.from),
          To: [{ Email: email.to }],
          Subject: email.subject,
          HTML: email.html,
          Text: email.text,
          Headers: { "X-Idempotency-Key": email.idempotencyKey },
        },
      ),
  };
}
