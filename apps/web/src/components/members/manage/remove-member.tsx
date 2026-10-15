"use client";

import type { HomeRole } from "@madeora/domain/permissions";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useHydrated } from "@/components/ui/use-hydrated";
import { removeMember, type MemberActionError } from "@/members/manage-api";

import { MemberFailureAlert } from "./member-failure-alert";

/**
 * Remove another member, after a confirmation that names the person and the Home and explains the
 * consequences (S12; spec removal reaffirmation: "identify the affected adult and Home, show loss
 * of access ... and require explicit confirmation"). The request carries the role the remover saw,
 * so a role change made meanwhile is refused. On success the directory opens with a notice.
 */
export function RemoveMember({
  homeId,
  homeName,
  membershipId,
  memberName,
  currentRole,
}: {
  readonly homeId: string;
  readonly homeName: string;
  readonly membershipId: string;
  readonly memberName: string;
  readonly currentRole: HomeRole;
}) {
  const t = useTranslations("Manage");
  const router = useRouter();
  const hydrated = useHydrated();
  const [confirming, setConfirming] = useState(false);

  const mutation = useMutation<undefined, MemberActionError>({
    mutationFn: async () => {
      await removeMember(homeId, membershipId, { expectedRole: currentRole });
      return undefined;
    },
    onSuccess: () => {
      setConfirming(false);
      router.push(`/homes/${homeId}/members?removed=1`);
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
          {t("removeButton", { name: memberName })}
        </Button>
      </div>
      <Dialog
        open={confirming}
        onClose={() => {
          if (!mutation.isPending) setConfirming(false);
        }}
        closeLabel={t("close")}
        title={t("removeConfirmTitle", { name: memberName, home: homeName })}
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
        <p className="mb-2 text-body font-medium text-fg">{t("removeConsequences")}</p>
        <ul className="flex list-disc flex-col gap-1 ps-5 text-body text-fg">
          <li>{t("removeAccess", { name: memberName })}</li>
          <li>{t("removeProfile")}</li>
          {currentRole === "administrator" ? <li>{t("removeInvitations")}</li> : null}
          <li>{t("removeContent")}</li>
          <li>{t("removeRejoin")}</li>
        </ul>
      </Dialog>
    </div>
  );
}
