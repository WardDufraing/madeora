"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useHydrated } from "@/components/ui/use-hydrated";
import { recoveryAction, type RecoveryActionError } from "@/recovery/api";
import type { ClaimantAction } from "@/recovery/schema";

import { RecoveryFailureAlert } from "./recovery-failure-alert";

/**
 * The person who asked: withdraw their open request, or accept ownership once it is ready (S12b).
 * Both ask for confirmation first; accepting explains what being Owner means.
 */
export function RecoveryClaimantActions({
  homeId,
  homeName,
  recoveryId,
  canAccept,
}: {
  readonly homeId: string;
  readonly homeName: string;
  readonly recoveryId: string;
  /** The objection period is over and nothing paused it. */
  readonly canAccept: boolean;
}) {
  const t = useTranslations("Recovery");
  const router = useRouter();
  const hydrated = useHydrated();
  const [confirming, setConfirming] = useState<ClaimantAction | null>(null);

  const mutation = useMutation<undefined, RecoveryActionError, ClaimantAction>({
    mutationFn: async (action) => {
      await recoveryAction(homeId, recoveryId, action);
      return undefined;
    },
    onSuccess: (_, action) => {
      setConfirming(null);
      router.replace(
        action === "accept" ? `/homes/${homeId}?recovery=accepted` : `/homes/${homeId}/recovery`,
        { scroll: false },
      );
      router.refresh();
    },
    onError: () => {
      setConfirming(null);
      router.refresh();
    },
  });

  return (
    <div className="flex flex-col gap-3">
      <RecoveryFailureAlert failure={mutation.error?.failure ?? null} />
      <div className="flex flex-wrap gap-2">
        {canAccept ? (
          <Button
            type="button"
            disabled={!hydrated}
            onClick={() => {
              mutation.reset();
              setConfirming("accept");
            }}
          >
            {t("acceptButton")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          disabled={!hydrated}
          onClick={() => {
            mutation.reset();
            setConfirming("withdraw");
          }}
        >
          {t("withdrawButton")}
        </Button>
      </div>
      <Dialog
        open={confirming !== null}
        onClose={() => {
          if (!mutation.isPending) setConfirming(null);
        }}
        closeLabel={t("close")}
        title={
          confirming === "accept"
            ? t("acceptConfirmTitle", { home: homeName })
            : t("withdrawConfirmTitle")
        }
        description={confirming === "accept" ? t("acceptConfirmText") : t("withdrawConfirmText")}
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
              variant={confirming === "withdraw" ? "destructive" : "primary"}
              loading={mutation.isPending}
              onClick={() => {
                if (confirming && !mutation.isPending) mutation.mutate(confirming);
              }}
            >
              {confirming === "accept" ? t("acceptConfirm") : t("withdrawConfirm")}
            </Button>
          </>
        }
      />
    </div>
  );
}
