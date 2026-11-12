"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { MemberFailureAlert } from "@/components/members/manage/member-failure-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useHydrated } from "@/components/ui/use-hydrated";
import { deleteMistakenChild } from "@/children/api";
import type { MemberActionError } from "@/members/manage-api";

/**
 * Deletes a child created by mistake (S41): offered to the creator and the primary guardian within
 * the correction window when this is the child's only Home; confirmed first, cannot be undone.
 */
export function DeleteMistakenChild({
  homeId,
  membershipId,
  childName,
}: {
  readonly homeId: string;
  readonly membershipId: string;
  readonly childName: string;
}) {
  const t = useTranslations("Children");
  const router = useRouter();
  const hydrated = useHydrated();
  const [confirming, setConfirming] = useState(false);
  const mutation = useMutation<undefined, MemberActionError>({
    mutationFn: async () => {
      await deleteMistakenChild(homeId, membershipId);
      return undefined;
    },
    onSuccess: () => {
      setConfirming(false);
      router.push(`/homes/${homeId}/members?childDeleted=1`);
      router.refresh();
    },
    onError: () => {
      setConfirming(false);
    },
  });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-body text-fg-muted">{t("deleteHint")}</p>
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
          {t("deleteButton", { name: childName })}
        </Button>
      </div>
      <Dialog
        open={confirming}
        onClose={() => {
          if (!mutation.isPending) setConfirming(false);
        }}
        closeLabel={t("close")}
        title={t("deleteConfirmTitle", { name: childName })}
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
              {t("deleteConfirm")}
            </Button>
          </>
        }
      >
        <p className="text-body text-fg">{t("deleteBody", { name: childName })}</p>
      </Dialog>
    </div>
  );
}
