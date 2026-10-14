"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";
import { withdrawJoinRequest, type InvitationActionError } from "@/invitations/api";
import { formatDateTime, type DateTimeFormats } from "@/invitations/format";
import type { MyJoinRequestView } from "@/invitations/types";

import { InvitationFailureAlert } from "./failure-alert";
import { useInvitationLabels } from "./use-labels";

/**
 * "Your join requests" (S10): every request this person made, with its state, and Withdraw for
 * those still waiting. An approved request links to the Home while they still belong to it.
 */
export function MyJoinRequests({
  requests,
  formats,
}: {
  readonly requests: readonly MyJoinRequestView[];
  readonly formats: DateTimeFormats;
}) {
  const t = useTranslations("Invitations");
  const labels = useInvitationLabels();
  const router = useRouter();
  const hydrated = useHydrated();
  const [withdrawn, setWithdrawn] = useState(false);

  const mutation = useMutation<undefined, InvitationActionError, string>({
    mutationFn: async (id) => {
      await withdrawJoinRequest(id);
      return undefined;
    },
    onSuccess: () => {
      setWithdrawn(true);
      router.refresh();
    },
    onError: () => {
      router.refresh();
    },
  });

  if (requests.length === 0) {
    return <p className="text-body text-fg-muted">{t("noMyRequests")}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {withdrawn ? (
        <FormAlert tone="success" announce>
          {t("withdrawn")}
        </FormAlert>
      ) : null}
      <InvitationFailureAlert failure={mutation.error?.failure ?? null} />
      <ul className="flex flex-col divide-y divide-line" aria-label={t("myRequestsLabel")}>
        {requests.map((request) => (
          <li
            key={request.id}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0"
            data-testid="my-join-request"
          >
            <div className="flex flex-col gap-1">
              <p className="text-body font-medium text-fg">
                {request.homeId ? (
                  <Link href={`/homes/${request.homeId}`} className="text-accent-fg underline">
                    <bdi>{request.homeName}</bdi>
                  </Link>
                ) : (
                  <bdi>{request.homeName}</bdi>
                )}
              </p>
              <p className="text-helper text-fg-muted">
                {labels.role(request.role)} {"\u{00B7}"}{" "}
                {formatDateTime(request.decidedAt ?? request.createdAt, formats)}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-helper font-medium text-fg" data-testid="my-join-request-state">
                {labels.requestState(request.state)}
              </span>
              {request.state === "pending" ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={!hydrated}
                  loading={mutation.isPending && mutation.variables === request.id}
                  onClick={() => {
                    if (mutation.isPending) return;
                    setWithdrawn(false);
                    mutation.mutate(request.id);
                  }}
                >
                  {t("withdraw")}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
