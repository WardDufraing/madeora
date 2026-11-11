"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { CopyActionError, decideHomeCopy } from "@/copies/api";
import type { CopyItemType } from "@/copies/catalogue";

export interface HomeCopyRequestRow {
  readonly id: string;
  readonly itemType: CopyItemType;
  readonly label: string | null;
  readonly files: number;
  readonly requester: string | null;
  readonly isMine: boolean;
  /** Formatted by the server page. */
  readonly requested: string;
  readonly expires: string;
}

const OUTCOMES = [
  "completed",
  "copying",
  "rejected",
  "expired",
  "invalidated",
  "failed",
  "not_pending",
] as const;
type DecisionOutcome = (typeof OUTCOMES)[number];

/**
 * A Home's copy requests for its approvers (S40 part 2): what is asked (kind, title, photos), who
 * asked, until when; Approve shows the ownership consequences first (the same for the approver's
 * own request), Reject ends it. Each decision is checked again by the database.
 */
export function HomeCopyRequests({
  homeName,
  rows,
}: {
  readonly homeName: string;
  readonly rows: readonly HomeCopyRequestRow[];
}) {
  const t = useTranslations("HomeCopies");
  const router = useRouter();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);

  const decide = (id: string, approve: boolean) => {
    setBusy(id);
    setMessage(null);
    decideHomeCopy(id, { approve })
      .then((outcome) => {
        const known: DecisionOutcome = (OUTCOMES as readonly string[]).includes(outcome)
          ? (outcome as DecisionOutcome)
          : "failed";
        setMessage({
          tone:
            known === "failed" || known === "invalidated" || known === "expired" ? "error" : "info",
          text: t(`decided.${known}`),
        });
        setConfirming(null);
        router.refresh();
      })
      .catch((error: unknown) => {
        if (error instanceof CopyActionError && error.failure === "signedOut") {
          window.location.assign(new URL("/sign-in", window.location.origin));
          return;
        }
        setMessage({
          tone: "error",
          text:
            error instanceof CopyActionError && error.failure === "notFound"
              ? t("decideGone")
              : t("failed"),
        });
        router.refresh();
      })
      .finally(() => {
        setBusy(null);
      });
  };

  return (
    <div className="flex flex-col gap-3">
      {message ? (
        <FormAlert tone={message.tone} announce>
          {message.text}
        </FormAlert>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-body">{t("queueEmpty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line" data-testid="copy-requests">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-2 py-3" data-testid="copy-request">
              <p className="text-body">
                <span className="font-semibold">{row.label ?? t(`untitled.${row.itemType}`)}</span>{" "}
                <span className="text-fg-muted">({t(`type.${row.itemType}`)})</span>
              </p>
              <p className="text-helper text-fg-muted">
                {row.isMine
                  ? t("requestedByYou", { date: row.requested })
                  : t("requestedBy", {
                      person: row.requester ?? t("someone"),
                      date: row.requested,
                    })}
                {" · "}
                {t("expires", { date: row.expires })}
                {row.files > 0
                  ? ` · ${t(`filesCount.${row.itemType}`, { count: row.files })}`
                  : null}
              </p>
              {confirming === row.id ? (
                <div className="flex flex-col gap-2 rounded-control border border-line bg-surface-sunken p-3">
                  <p className="text-body">{t("approveConsequences", { home: homeName })}</p>
                  {row.isMine ? <p className="text-body">{t("approveOwn")}</p> : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      loading={busy === row.id}
                      disabled={busy !== null}
                      onClick={() => {
                        decide(row.id, true);
                      }}
                      data-testid="copy-request-confirm"
                    >
                      {t("approveConfirm")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => {
                        setConfirming(null);
                      }}
                    >
                      {t("back")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => {
                      setConfirming(row.id);
                    }}
                    data-testid="copy-request-approve"
                  >
                    {t("approve")}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === row.id}
                    disabled={busy !== null}
                    onClick={() => {
                      decide(row.id, false);
                    }}
                    data-testid="copy-request-reject"
                  >
                    {t("reject")}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
