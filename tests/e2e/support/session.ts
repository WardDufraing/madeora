import type { BrowserContext } from "@playwright/test";

/** The Supabase session cookie of `context`, decoded (`@supabase/ssr` format: `base64-` + JSON, maybe in chunks). */
export async function readSession(
  context: BrowserContext,
): Promise<{ name: string; session: Record<string, unknown> }> {
  const cookies = (await context.cookies()).filter((cookie) =>
    /^sb-.+-auth-token(\.\d+)?$/.test(cookie.name),
  );
  if (cookies.length === 0) throw new Error("no session cookie");
  const name = (cookies[0]?.name ?? "").replace(/\.\d+$/, "");
  const value = cookies
    .sort((a, b) => Number(a.name.split(".").pop()) - Number(b.name.split(".").pop()))
    .map((cookie) => cookie.value)
    .join("");
  const json = Buffer.from(value.replace(/^base64-/, ""), "base64url").toString("utf8");
  return { name, session: JSON.parse(json) as Record<string, unknown> };
}
