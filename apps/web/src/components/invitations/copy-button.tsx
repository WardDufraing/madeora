"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Copies `text` to the clipboard and says so in a polite live region. Where the clipboard is not
 * available (an insecure page, a refused permission), it says that instead; the text is also
 * shown in a field next to the button, so it can always be selected by hand.
 */
export function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
  const t = useTranslations("Invitations");
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => {
          navigator.clipboard
            .writeText(text)
            .then(() => {
              setStatus("copied");
            })
            .catch(() => {
              setStatus("failed");
            });
        }}
      >
        {label}
      </Button>
      <span role="status" className="text-helper text-fg-muted">
        {status === "copied" ? t("copied") : status === "failed" ? t("copyFailed") : ""}
      </span>
    </span>
  );
}
