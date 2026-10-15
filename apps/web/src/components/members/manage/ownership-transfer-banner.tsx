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
  ownershipTransferAction,
  type MemberActionError,
  type TransferActionResponse,
} from "@/members/manage-api";
import type { TransferAction } from "@/members/manage-schema";

import { MemberFailureAlert } from "./member-failure-alert";

export interface OwnershipTransferBannerProps {
  readonly homeId: string;
  readonly homeName: string;
  readonly transferId: string;
  /** `recipient`: the member asked to become Owner; `sender`: the Owner who asked. */
  readonly viewer: "recipient" | "sender";
  /** The other person's visible name in this Home (for the sender: the nominated member). */
  readonly otherName: string;
  /** When the request ends, already formatted for the viewer. */
  readonly expiresLabel: string;
}

/**
 * A pending ownership transfer on the Home dashboard (S12; spec "Provide clear pending, accepted,
 * declined, canceled, expired/invalid ... states"). The nominated member accepts (after a
 * confirmation explaining what being Owner means) or declines; the Owner who asked can cancel.
 * Nobody else sees it. Notifications arrive with S14; until then this is where the request shows.
 */
export function OwnershipTransferBanner({
  homeId,
  homeName,
  transferId,
  viewer,
  otherName,
  expiresLabel,
}: OwnershipTransferBannerProps) {
  const t = useTranslations("Manage");
  const router = useRouter();
  const hydrated = useHydrated();
  const [confirmingAccept, setConfirmingAccept] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const mutation = useMutation<TransferActionResponse, MemberActionError, TransferAction>({
    mutationFn: (action) => ownershipTransferAction(homeId, transferId, action),
    onSuccess: ({ outcome }) => {
      setConfirmingAccept(false);
      setNotice(
        outcome === "accepted"
          ? t("accepted", { home: homeName })
          : outcome === "declined"
            ? t("declined")
            : t("cancelled"),
      );
      // The banner goes away once the page reloads without a pending transfer, so the server
      // repeats the confirmation from the address (OwnershipTransferNotice `done`).
      router.replace(`/homes/${homeId}?transfer=${outcome}`, { scroll: false });
    },
    onError: () => {
      setConfirmingAccept(false);
      router.refresh();
    },
  });

  if (notice) {
    return (
      <FormAlert tone="success" announce className="mb-6">
        {notice}
      </FormAlert>
    );
  }

  const busy = !hydrated || mutation.isPending;
  return (
    <section
      className="mb-6 flex flex-col gap-3 rounded-card border border-info bg-info-subtle p-4"
      aria-labelledby="ownership-transfer-title"
      data-testid="ownership-transfer-banner"
    >
      <h2 id="ownership-transfer-title" className="text-body font-semibold text-fg">
        {viewer === "recipient"
          ? t("bannerRecipientTitle", { home: homeName })
          : t("bannerSenderTitle", { name: otherName })}
      </h2>
      <p className="text-body text-fg">
        {viewer === "recipient"
          ? t("bannerRecipientText", { date: expiresLabel })
          : t("bannerSenderText", { name: otherName, date: expiresLabel })}
      </p>
      <MemberFailureAlert failure={mutation.error?.failure ?? null} />
      <div className="flex flex-wrap gap-2">
        {viewer === "recipient" ? (
          <>
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                mutation.reset();
                setConfirmingAccept(true);
              }}
            >
              {t("bannerAccept")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              loading={mutation.isPending && mutation.variables === "decline"}
              onClick={() => {
                mutation.mutate("decline");
              }}
            >
              {t("bannerDecline")}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            loading={mutation.isPending && mutation.variables === "cancel"}
            onClick={() => {
              mutation.mutate("cancel");
            }}
          >
            {t("bannerCancel")}
          </Button>
        )}
      </div>
      <Dialog
        open={confirmingAccept}
        onClose={() => {
          if (!mutation.isPending) setConfirmingAccept(false);
        }}
        closeLabel={t("close")}
        title={t("acceptConfirmTitle", { home: homeName })}
        description={t("acceptConfirmText")}
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={mutation.isPending}
              onClick={() => {
                setConfirmingAccept(false);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              loading={mutation.isPending}
              onClick={() => {
                if (!mutation.isPending) mutation.mutate("accept");
              }}
            >
              {t("acceptConfirm")}
            </Button>
          </>
        }
      />
    </section>
  );
}
