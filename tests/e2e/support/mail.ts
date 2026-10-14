import { e2eEnv } from "./env";

interface MailpitSummary {
  readonly ID: string;
  readonly Subject: string;
  readonly To: readonly { readonly Address: string }[];
}

/**
 * The link in the newest email to `address` whose subject contains `subject`, read from the
 * Mailpit mail catcher. Polls, because Supabase Auth sends mail asynchronously.
 */
export async function emailLink(address: string, subject: string): Promise<URL> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const search = await fetch(
      `${e2eEnv.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
    );
    if (search.ok) {
      const { messages } = (await search.json()) as { messages: MailpitSummary[] };
      const match = messages.find((message) => message.Subject.includes(subject));
      if (match) {
        const detail = (await (
          await fetch(`${e2eEnv.mailpitUrl}/api/v1/message/${match.ID}`)
        ).json()) as {
          HTML: string;
        };
        const href = /href="([^"]+)"/.exec(detail.HTML)?.[1];
        if (!href) throw new Error(`No link in the email "${match.Subject}" to ${address}`);
        return new URL(href.replace(/&amp;/g, "&"));
      }
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`No email "${subject}" to ${address} arrived`);
}

/** How many emails `address` has received. */
export async function emailCount(address: string): Promise<number> {
  const search = await fetch(
    `${e2eEnv.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
  );
  const { messages } = (await search.json()) as { messages: MailpitSummary[] };
  return messages.length;
}

export const subjects = {
  confirmation: "Confirm your Madeora email address",
  recovery: "Reset your Madeora password",
} as const;
