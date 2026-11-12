"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { MemberFailureAlert } from "@/components/members/manage/member-failure-alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useHydrated } from "@/components/ui/use-hydrated";
import { removeChild } from "@/children/api";
import type { MemberActionError } from "@/members/manage-api";

/**
 * Removes the child from this Home after a confirmation naming the child and the Home (S41). The
 * child keeps their identity and other Homes; their only Home cannot be left this way.
 */
export function RemoveChild({
  homeId,
  homeName,
  membershipId,
  childName,
}: {
  readonly homeId: string;
  readonly homeName: string;
  readonly membershipId: string;
  readonly childName: string;
}) {
  const t = useTranslations("Children");
  const router = useRouter();
  const hydrated = useHydrated();
  const [confirming, setConfirming] = useState(false);
  const mutation = useMutation<undefined, MemberActionError>({
    mutationFn: async () => {
      await removeChild(homeId, membershipId);
      return undefined;
    },
    onSuccess: () => {
      setConfirming(false);
      router.push(`/homes/${homeId}/members?removed=1`);
      router.refresh();
    },
    onError: () => {
      setConfirming(false);
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
          {t("removeButton", { name: childName })}
        </Button>
      </div>
      <Dialog
        open={confirming}
        onClose={() => {
          if (!mutation.isPending) setConfirming(false);
        }}
        closeLabel={t("close")}
        title={t("removeConfirmTitle", { name: childName, home: homeName })}
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
              {t("removeConfirm")}
            </Button>
          </>
        }
      >
        <p className="text-body text-fg">{t("removeBody", { name: childName, home: homeName })}</p>
      </Dialog>
    </div>
  );
}
