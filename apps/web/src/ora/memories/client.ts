import type { OraActionId } from "@/ora/actions/types";

import type { MemoryKey } from "./types";

/** The browser's callers for what Ora remembers (S47b). */

export class OraMemoryError extends Error {
  constructor() {
    super("Ora memory call failed");
    this.name = "OraMemoryError";
  }
}

async function send(method: "POST" | "DELETE", body: unknown): Promise<void> {
  let response: Response;
  try {
    response = await fetch("/api/v1/ora/memories", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new OraMemoryError();
  }
  if (!response.ok) throw new OraMemoryError();
}

export const rememberList = (input: {
  readonly homeId: string | null;
  readonly action: OraActionId;
  readonly listId: string;
}): Promise<void> => send("POST", input);

export const forgetMemory = (input: {
  readonly homeId: string | null;
  readonly key: MemoryKey;
}): Promise<void> => send("DELETE", input);
