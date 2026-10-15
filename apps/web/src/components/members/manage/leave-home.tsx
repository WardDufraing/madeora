"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useHydrated } from "@/components/ui/use-hydrated";
import { leaveHome, type MemberActionError } from "@/members/manage-api";

import { MemberFailureAlert } from "./member-failure-alert";

/**
 * Leave a Home, after one confirmation (S12; spec "Confirmed voluntary Home departure": no
 * approval needed, explicit confirmation of the consequences, which the page lists above this).
 * Afterwards the personal space opens with a notice; the Home's pages and data are already out of
 * reach because every request reads the membership afresh.
 */
export function LeaveHome({
  homeId,
  homeName,
}: {
  readonly homeId: string;
  readonly homeName: string;
}) {
  const t = useTranslations("Manage");
  const router = useRouter();
  const hydrated = useHydrated();
  const [confirming, setConfirming] = useState(false);

  const mutation = useMutation<undefined, MemberActionError>({
    mutationFn: async () => {
      await leaveHome(homeId);
      return undefined;
    },
    onSuccess: () => {
      setConfirming(false);
      router.replace("/?notice=home-left");
      router.refresh();
    },
    onError: () => {
      setConfirming(false);
      router.refresh();
    },
  });

  return (
    <div className="flex flex-col gap-3">
      <MemberFailureAlert failure={mutation.error?.failure ?? null} />
      <div>
        <Button
          type="button"
          variant="destructive"
          disabled={!hydrated}
          onClick={() => {
            mutation.reset();
            setConfirming(true);
          }}
        >
          {t("leaveButton", { home: homeName })}
        </Button>
      </div>
      <Dialog
        open={confirming}
        onClose={() => {
          if (!mutation.isPending) setConfirming(false);
        }}
        closeLabel={t("close")}
        title={t("leaveConfirmTitle", { home: homeName })}
        description={t("leaveConfirmText")}
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={mutation.isPending}
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={mutation.isPending}
              onClick={() => {
                if (!mutation.isPending) mutation.mutate();
              }}
            >
              {t("leaveConfirm")}
            </Button>
          </>
        }
      />
    </div>
  );
}
