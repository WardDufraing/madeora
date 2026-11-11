"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cancelPendingHomeCopies, CopyActionError } from "@/copies/api";
import type { CopyItemType } from "@/copies/catalogue";

export interface OpenCopyRow {
  readonly id: string;
  readonly homeName: string;
  readonly itemType: CopyItemType;
  readonly label: string | null;
  readonly status: "pending" | "copying";
  /** Formatted by the server page. */
  readonly expires: string;
}

/**
 * Before account deletion (S40 part 2, spec "Confirmed pending content transfers during account
 * deletion"): every open copy request with its Home, a warning that unapproved items are not kept,
 * and an explicit acknowledgement before all pending requests are cancelled. Copies being made
 * finish first. Nobody else is told.
 */
export function CancelPendingCopies({ rows }: { readonly rows: readonly OpenCopyRow[] }) {
  const t = useTranslations("HomeCopies");
  const router = useRouter();
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pending = rows.filter((row) => row.status === "pending");
  const running = rows.length - pending.length;

  return (
    <div className="flex flex-col gap-3" data-testid="account-deletion-copies">
      <FormAlert tone="info">{t("deletionWarning")}</FormAlert>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.id} className="text-body">
            <span className="font-semibold">{row.label ?? t(`itemGone.${row.itemType}`)}</span>
            {" → "}
            <bdi>{row.homeName}</bdi>
            {" · "}
            {row.status === "pending"
              ? t("deletionPending", { date: row.expires })
              : t("deletionRunning")}
          </li>
        ))}
      </ul>
      {running > 0 ? <p className="text-body">{t("deletionRunningHint")}</p> : null}
      {pending.length > 0 ? (
        <>
          <Checkbox
            label={t("deletionAcknowledge")}
            checked={understood}
            disabled={busy}
            onChange={(event) => {
              setUnderstood(event.target.checked);
            }}
            data-testid="account-deletion-copies-ack"
          />
          {message ? (
            <FormAlert tone="error" announce>
              {message}
            </FormAlert>
          ) : null}
          <Button
            variant="secondary"
            className="self-start"
            loading={busy}
            onClick={() => {
              if (!understood) {
                setMessage(t("deletionAcknowledgeRequired"));
                return;
              }
              setBusy(true);
              setMessage(null);
              cancelPendingHomeCopies()
                .then(() => {
                  router.refresh();
                })
                .catch((error: unknown) => {
                  if (error instanceof CopyActionError && error.failure === "signedOut") {
                    window.location.assign(new URL("/sign-in", window.location.origin));
                    return;
                  }
                  setMessage(t("failed"));
                })
                .finally(() => {
                  setBusy(false);
                });
            }}
            data-testid="account-deletion-copies-cancel"
          >
            {t("deletionCancelAll", { count: pending.length })}
          </Button>
        </>
      ) : null}
      <Link
        href="/settings/privacy/copies"
        className="text-body font-medium text-accent-fg underline"
      >
        {t("myRequestsLink")}
      </Link>
    </div>
  );
}
