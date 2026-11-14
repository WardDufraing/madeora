"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * "Why am I seeing this?" for a suggestion (S47c; spec "minimal suggestion explanations"): a short,
 * factual line on request, never shown by default. It names the basis (open things today in this
 * place, from what the person may see) and where to switch suggestions off.
 */
export function OraWhy() {
  const t = useTranslations("Ora");
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {t("suggestions.why")}
      </Button>
      {open ? (
        <p id={id} className="basis-full text-helper text-fg-muted">
          {t("suggestions.whyText")}
        </p>
      ) : null}
    </>
  );
}
