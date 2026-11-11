"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { cancelHomeCopy, CopyActionError } from "@/copies/api";
import { endCodeOf, type CopyItemType, type CopyStatus } from "@/copies/catalogue";

export interface MyCopyRow {
  readonly id: string;
  readonly homeName: string;
  readonly itemType: CopyItemType;
  readonly label: string | null;
  readonly status: CopyStatus;
  readonly code: string | null;
  readonly selfApproved: boolean;
  /** Formatted by the server page. */
  readonly requested: string;
  readonly expires: string;
}

/**
 * The person's own copy requests (S40 part 2): per Home, its state, the expiry of a pending one and
 * why one ended; a pending request can be cancelled here.
 */
export function MyHomeCopies({ rows }: { readonly rows: readonly MyCopyRow[] }) {
  const t = useTranslations("HomeCopies");
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (rows.length === 0) return <p className="text-body">{t("mineEmpty")}</p>;

  return (
    <div className="flex flex-col gap-3">
      {message ? (
        <FormAlert tone="error" announce>
          {message}
        </FormAlert>
      ) : null}
      <ul className="flex flex-col divide-y divide-line" data-testid="my-copies">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex flex-col gap-1 py-3"
            data-testid={`my-copy-${row.status}`}
          >
            <p className="text-body">
              <span className="font-semibold">{row.label ?? t(`itemGone.${row.itemType}`)}</span>
              {" → "}
              <bdi>{row.homeName}</bdi>
            </p>
            <p className="text-helper text-fg-muted">
              {t(`type.${row.itemType}`)} · {t(`status.${row.status}`)}
              {row.status === "pending" ? ` · ${t("expires", { date: row.expires })}` : null}
              {row.status === "failed" || row.status === "invalidated"
                ? ` · ${t(`endCode.${endCodeOf(row.code)}`)}`
                : null}
              {row.selfApproved ? ` · ${t("selfApproved")}` : null}
            </p>
            <p className="text-helper text-fg-muted">{t("requestedOn", { date: row.requested })}</p>
            {row.status === "pending" ? (
              <Button
                variant="secondary"
                size="sm"
                className="self-start"
                loading={busy === row.id}
                disabled={busy !== null}
                onClick={() => {
                  setBusy(row.id);
                  setMessage(null);
                  cancelHomeCopy(row.id)
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
                      setBusy(null);
                    });
                }}
                data-testid="my-copy-cancel"
              >
                {t("cancel")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
