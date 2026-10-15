"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  startOwnershipTransfer,
  type MemberActionError,
  type StartTransferResponse,
} from "@/members/manage-api";

import { MemberFailureAlert } from "./member-failure-alert";

/**
 * The Owner asks one member to become the next Owner (S12; spec "Confirmed Home ownership
 * transfer"). The confirmation explains that nothing changes until they accept. One request id per
 * confirmation, so a double click or a retry starts one transfer.
 */
export function NominateOwner({
  homeId,
  homeName,
  membershipId,
  memberName,
  variant = "secondary",
}: {
  readonly homeId: string;
  readonly homeName: string;
  readonly membershipId: string;
  readonly memberName: string;
  readonly variant?: "primary" | "secondary";
}) {
  const t = useTranslations("Manage");
  const router = useRouter();
  const hydrated = useHydrated();
  const [requestId, setRequestId] = useState<string | null>(null);

  const mutation = useMutation<StartTransferResponse, MemberActionError, string>({
    mutationFn: (id) => startOwnershipTransfer(homeId, { membershipId, requestId: id }),
    onSuccess: () => {
      setRequestId(null);
      router.push(`/homes/${homeId}`);
      router.refresh();
    },
    onError: () => {
      setRequestId(null);
      router.refresh();
    },
  });

  return (
    <div className="flex flex-col gap-3">
      <MemberFailureAlert failure={mutation.error?.failure ?? null} />
      <div>
        <Button
          type="button"
          variant={variant}
          disabled={!hydrated}
          onClick={() => {
            mutation.reset();
            setRequestId(crypto.randomUUID());
          }}
        >
          {t("transferButton", { name: memberName })}
        </Button>
      </div>
      <Dialog
        open={requestId !== null}
        onClose={() => {
          if (!mutation.isPending) setRequestId(null);
        }}
        closeLabel={t("close")}
        title={t("transferConfirmTitle", { name: memberName, home: homeName })}
        description={t("transferConsequences", { name: memberName })}
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={mutation.isPending}
              onClick={() => {
                setRequestId(null);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              loading={mutation.isPending}
              onClick={() => {
                if (requestId && !mutation.isPending) mutation.mutate(requestId);
              }}
            >
              {t("transferConfirm")}
            </Button>
          </>
        }
      />
    </div>
  );
}
