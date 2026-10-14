"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useHydrated } from "@/components/ui/use-hydrated";
import { useNow } from "@/components/ui/use-now";
import {
  invitationAction,
  type EmailSentResponse,
  type InvitationActionError,
} from "@/invitations/api";
import { expiryDurationMs, formatDateTime, type DateTimeFormats } from "@/invitations/format";
import type { InvitationView } from "@/invitations/types";

import { CopyButton } from "./copy-button";
import { InvitationFailureAlert } from "./failure-alert";
import { useInvitationLabels } from "./use-labels";

/** An invitation with what to copy, built on the server (the app address is server config). */
export interface InvitationRow extends InvitationView {
  /** Active links and codes: the address to share. */
  readonly url: string | null;
  /** Active join codes: the code as people type it. */
  readonly code: string | null;
}

type Action = "revoke" | "resend" | "renew";

interface Pending {
  readonly action: Action;
  readonly invitation: InvitationRow;
}

/**
 * The Home's invitations, newest first, with their state, expiry, uses and delivery, and the
 * actions each allows: copy (links and codes), resend and renew (email invitations nobody used
 * yet) and revoke. Renew and revoke ask first; renew says the new expiry. The server decides
 * again; a refusal is shown and the list is refreshed.
 */
export function InvitationList({
  homeId,
  invitations,
  formats,
}: {
  readonly homeId: string;
  readonly invitations: readonly InvitationRow[];
  readonly formats: DateTimeFormats;
}) {
  const t = useTranslations("Invitations");
  const labels = useInvitationLabels();
  const router = useRouter();
  const hydrated = useHydrated();
  const now = useNow();
  const [confirming, setConfirming] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mutation = useMutation<EmailSentResponse | null, InvitationActionError, Pending>({
    mutationFn: ({ action, invitation }) => invitationAction(homeId, invitation.id, action),
    onSuccess: (result, { action, invitation }) => {
      setConfirming(null);
      const email = invitation.recipientEmail ?? "";
      if (action === "revoke") setNotice(t("revoked"));
      else if (result?.delivery === "sent") {
        setNotice(action === "renew" ? t("renewedSent", { email }) : t("resent", { email }));
      } else {
        setNotice(
          result?.delivery === "not_configured"
            ? t("deliveryNotConfiguredHint")
            : t("deliveryFailedHint"),
        );
      }
      router.refresh();
    },
    onError: () => {
      setConfirming(null);
      setNotice(null);
      router.refresh();
    },
  });

  function start(action: Action, invitation: InvitationRow) {
    if (mutation.isPending) return;
    setNotice(null);
    mutation.reset();
    if (action === "resend") mutation.mutate({ action, invitation });
    else setConfirming({ action, invitation });
  }

  if (invitations.length === 0) {
    return <p className="text-body text-fg-muted">{t("noInvitations")}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {notice ? (
        <FormAlert tone="success" announce>
          {notice}
        </FormAlert>
      ) : null}
      <InvitationFailureAlert failure={mutation.error?.failure ?? null} />
      <ul className="flex flex-col divide-y divide-line" aria-label={t("listLabel")}>
        {invitations.map((invitation) => {
          const active = invitation.state === "active";
          const canEmail =
            active && invitation.kind === "email" && invitation.pendingRequests === 0;
          return (
            <li
              key={invitation.id}
              className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0"
              data-testid="invitation-row"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="text-body font-medium text-fg">
                  {invitation.kind === "email" && invitation.recipientEmail ? (
                    <>
                      {labels.kind(invitation.kind)}
                      {": "}
                      <bdi>{invitation.recipientEmail}</bdi>
                    </>
                  ) : (
                    labels.kind(invitation.kind)
                  )}
                </p>
                <p className="text-helper font-medium text-fg" data-testid="invitation-state">
                  {labels.invitationState(invitation.state)}
                </p>
              </div>
              <dl className="grid gap-x-4 gap-y-1 text-helper text-fg-muted sm:grid-cols-[max-content_1fr]">
                <dt>{t("roleTerm")}</dt>
                <dd>{labels.role(invitation.role)}</dd>
                <dt>{active ? t("expiresTerm") : t("expiredOrEndedTerm")}</dt>
                <dd>
                  {formatDateTime(
                    active || invitation.endedAt === null
                      ? invitation.expiresAt
                      : invitation.endedAt,
                    formats,
                  )}
                </dd>
                <dt>{t("usesTerm")}</dt>
                <dd>
                  {invitation.maxUses === null
                    ? t("usesUnlimited", { used: invitation.uses })
                    : t("usesCapped", {
                        used: invitation.uses,
                        max: invitation.maxUses,
                        left: Math.max(invitation.maxUses - invitation.uses, 0),
                      })}
                </dd>
                {invitation.pendingRequests > 0 ? (
                  <>
                    <dt>{t("waitingTerm")}</dt>
                    <dd>{t("waitingCount", { count: invitation.pendingRequests })}</dd>
                  </>
                ) : null}
                {invitation.kind === "email" && invitation.delivery ? (
                  <>
                    <dt>{t("deliveryTerm")}</dt>
                    <dd data-testid="invitation-delivery">{t(deliveryKey[invitation.delivery])}</dd>
                  </>
                ) : null}
              </dl>
              {active ? (
                <div className="flex flex-wrap items-center gap-2">
                  {invitation.code ? (
                    <span className="font-mono text-body font-semibold tracking-widest text-fg">
                      {invitation.code}
                    </span>
                  ) : null}
                  {invitation.url ? (
                    <CopyButton text={invitation.url} label={t("copyLink")} />
                  ) : null}
                  {invitation.code ? (
                    <CopyButton text={invitation.code} label={t("copyCode")} />
                  ) : null}
                  {canEmail ? (
                    <>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={!hydrated}
                        loading={
                          mutation.isPending &&
                          mutation.variables.invitation.id === invitation.id &&
                          mutation.variables.action === "resend"
                        }
                        onClick={() => {
                          start("resend", invitation);
                        }}
                      >
                        {t("resend")}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={!hydrated}
                        onClick={() => {
                          start("renew", invitation);
                        }}
                      >
                        {t("renew")}
                      </Button>
                    </>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!hydrated}
                    onClick={() => {
                      start("revoke", invitation);
                    }}
                  >
                    {t("revoke")}
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <Dialog
        open={confirming !== null}
        onClose={() => {
          if (!mutation.isPending) setConfirming(null);
        }}
        closeLabel={t("close")}
        title={confirming?.action === "renew" ? t("renewTitle") : t("revokeTitle")}
        description={
          confirming?.action === "renew" && now !== null
            ? t("renewDescription", {
                date: formatDateTime(new Date(now + expiryDurationMs["7d"]), formats),
              })
            : confirming?.action === "renew"
              ? t("renewDescriptionNoDate")
              : t("revokeDescription")
        }
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={mutation.isPending}
              onClick={() => {
                setConfirming(null);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              variant={confirming?.action === "revoke" ? "destructive" : "primary"}
              loading={mutation.isPending}
              onClick={() => {
                if (confirming && !mutation.isPending) mutation.mutate(confirming);
              }}
            >
              {confirming?.action === "renew" ? t("renewConfirm") : t("revokeConfirm")}
            </Button>
          </>
        }
      />
    </div>
  );
}

const deliveryKey = {
  pending: "deliveryPending",
  sent: "deliverySent",
  failed: "deliveryFailed",
  not_configured: "deliveryNotConfigured",
} as const;
