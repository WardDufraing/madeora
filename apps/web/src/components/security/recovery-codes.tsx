"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

export interface RecoveryCodesProps {
  readonly codes: readonly string[];
  readonly onDone: () => void;
  /** Two-factor recovery codes (default) or account recovery codes (lost password and mailbox). */
  readonly kind?: "twoFactor" | "account";
}

/**
 * Shows a new set of two-factor or account recovery codes once (S37). They live only in this component's
 * memory: never stored, cached or sent anywhere by Madeora, and gone once the person continues.
 */
export function RecoveryCodes({ codes, onDone, kind = "twoFactor" }: RecoveryCodesProps) {
  const t = useTranslations("Security");
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const account = kind === "account";
  const heading = account ? t("accountCodesFileHeading") : t("recoveryFileHeading");
  const text = `${heading}\n\n${codes.join("\n")}\n`;

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = account ? "madeora-account-recovery-codes.txt" : "madeora-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-4" data-testid="recovery-codes">
      <FormAlert tone="success" announce>
        {t("recoveryCodesShownOnce")}
      </FormAlert>
      <p className="text-body">{account ? t("accountCodesAdvice") : t("recoveryCodesAdvice")}</p>
      <ul
        aria-label={account ? t("accountCodesTitle") : t("recoveryCodesTitle")}
        className="grid grid-cols-1 gap-2 rounded-control border border-line p-4 font-mono text-body sm:grid-cols-2"
      >
        {codes.map((code) => (
          <li key={code} data-testid="recovery-code">
            {code}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="secondary"
          onClick={() => {
            navigator.clipboard.writeText(text).then(
              () => {
                setCopied("copied");
              },
              () => {
                setCopied("failed");
              },
            );
          }}
        >
          {t("copyCodes")}
        </Button>
        <Button variant="secondary" onClick={download}>
          {t("downloadCodes")}
        </Button>
      </div>
      {copied ? (
        <p role="status" className="text-helper text-fg-muted">
          {copied === "copied" ? t("codesCopied") : t("codesNotCopied")}
        </p>
      ) : null}
      <Checkbox
        label={t("codesSaved")}
        checked={saved}
        onChange={(event) => {
          setSaved(event.target.checked);
        }}
      />
      <div>
        <Button disabled={!saved} onClick={onDone}>
          {t("codesDone")}
        </Button>
      </div>
    </div>
  );
}
