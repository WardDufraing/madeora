"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  decideJoinRequest,
  type DecisionResponse,
  type InvitationActionError,
} from "@/invitations/api";
import { formatDateTime, type DateTimeFormats } from "@/invitations/format";
import type { JoinRequestView } from "@/invitations/types";

import { InvitationFailureAlert } from "./failure-alert";
import { useInvitationLabels } from "./use-labels";

interface Decision {
  readonly request: JoinRequestView;
  readonly decision: "approve" | "decline";
}

/**
 * Join requests waiting for a manager (S10): who asked (display name and verified email), for
 * which role, how they came and when, with Approve and Decline (Decline asks first). Approval is
 * the membership boundary; the database checks the invitation again at that moment. Requests
 * this manager may not decide (an Administrator role, which only the Owner decides) say so.
 */
export function JoinRequestList({
  homeId,
  requests,
  formats,
}: {
  readonly homeId: string;
  readonly requests: readonly JoinRequestView[];
  readonly formats: DateTimeFormats;
}) {
  const t = useTranslations("Invitations");
  const labels = useInvitationLabels();
  const router = useRouter();
  const hydrated = useHydrated();
  const [declining, setDeclining] = useState<JoinRequestView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mutation = useMutation<DecisionResponse, InvitationActionError, Decision>({
    mutationFn: ({ request, decision }) => decideJoinRequest(homeId, request.id, { decision }),
    onSuccess: ({ outcome }, { request }) => {
      setDeclining(null);
      const name = request.applicantName ?? request.applicantEmail;
      setNotice(outcome === "approved" ? t("approved", { name }) : t("declined", { name }));
      router.refresh();
    },
    onError: () => {
      setDeclining(null);
      setNotice(null);
      router.refresh();
    },
  });

  function decide(request: JoinRequestView, decision: "approve" | "decline") {
    if (mutation.isPending) return;
    setNotice(null);
    mutation.reset();
    if (decision === "decline") setDeclining(request);
    else mutation.mutate({ request, decision });
  }

  const pending = requests.filter((request) => request.state === "pending");

  return (
    <div className="flex flex-col gap-4">
      {notice ? (
        <FormAlert tone="success" announce>
          {notice}
        </FormAlert>
      ) : null}
      <InvitationFailureAlert failure={mutation.error?.failure ?? null} />
      {pending.length === 0 ? (
        <p className="text-body text-fg-muted">{t("noRequests")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line" aria-label={t("requestsLabel")}>
          {pending.map((request) => (
            <li
              key={request.id}
              className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0"
              data-testid="join-request-row"
            >
              <p className="text-body font-medium text-fg">
                <bdi>{request.applicantName ?? request.applicantEmail}</bdi>
              </p>
              <dl className="grid gap-x-4 gap-y-1 text-helper text-fg-muted sm:grid-cols-[max-content_1fr]">
                <dt>{t("emailTerm")}</dt>
                <dd>
                  <bdi>{request.applicantEmail}</bdi>
                </dd>
                <dt>{t("roleTerm")}</dt>
                <dd>{labels.role(request.role)}</dd>
                <dt>{t("viaTerm")}</dt>
                <dd>{labels.kind(request.kind)}</dd>
                <dt>{t("requestedTerm")}</dt>
                <dd>{formatDateTime(request.createdAt, formats)}</dd>
              </dl>
              {request.canDecide ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={!hydrated}
                    loading={
                      mutation.isPending &&
                      mutation.variables.request.id === request.id &&
                      mutation.variables.decision === "approve"
                    }
                    onClick={() => {
                      decide(request, "approve");
                    }}
                  >
                    {t("approve")}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!hydrated}
                    onClick={() => {
                      decide(request, "decline");
                    }}
                  >
                    {t("decline")}
                  </Button>
                </div>
              ) : (
                <p className="text-helper text-fg-muted">{t("ownerDecides")}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={declining !== null}
        onClose={() => {
          if (!mutation.isPending) setDeclining(null);
        }}
        closeLabel={t("close")}
        title={t("declineTitle")}
        description={t("declineDescription", {
          name: declining?.applicantName ?? declining?.applicantEmail ?? "",
        })}
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={mutation.isPending}
              onClick={() => {
                setDeclining(null);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={mutation.isPending}
              onClick={() => {
                if (declining && !mutation.isPending) {
                  mutation.mutate({ request: declining, decision: "decline" });
                }
              }}
            >
              {t("declineConfirm")}
            </Button>
          </>
        }
      />
    </div>
  );
}
