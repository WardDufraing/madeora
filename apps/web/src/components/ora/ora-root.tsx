import { getOraSettings } from "@/ora/server";

import { OraAssistant, type OraAssistantProps } from "./ora-assistant";

export interface OraRootProps {
  readonly userId: string;
  readonly homes: OraAssistantProps["homes"];
}

/**
 * Reads the person's own Ora settings on the server and shows the assistant unless they hid and
 * disabled it (spec: nothing of Ora appears while disabled, and the rest of Madeora is
 * unaffected). Remounted for another account through the `key`, so no state crosses people.
 */
export async function OraRoot({ userId, homes }: OraRootProps) {
  const settings = await getOraSettings();
  if (!settings.enabled) return null;
  return <OraAssistant key={userId} userId={userId} settings={settings} homes={homes} />;
}
