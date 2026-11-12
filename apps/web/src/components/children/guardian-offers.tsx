"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { MemberFailureAlert } from "@/components/members/manage/member-failure-alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useHydrated } from "@/components/ui/use-hydrated";
import { answerGuardianOffer } from "@/children/api";
import type { MemberActionError } from "@/members/manage-api";

export interface GuardianOfferView {
  readonly offerId: string;
  readonly childName: string;
  readonly role: "primary" | "secondary";
  /** Already formatted for the viewer. */
  readonly expires: string;
}

/**
 * Guardian roles offered to the viewer in this Home (S41; spec: guardian acceptance before
 * activation). Nothing applies until they accept; the database re-checks the offer then.
 */
export function GuardianOffers({
  homeId,
  offers,
}: {
  readonly homeId: string;
  readonly offers: readonly GuardianOfferView[];
}) {
  const t = useTranslations("Children");
  const router = useRouter();
  const hydrated = useHydrated();
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useMutation<
    "accepted" | "declined" | "cancelled",
    MemberActionError,
    { readonly offer: GuardianOfferView; readonly accept: boolean }
  >({
    mutationFn: ({ offer, accept }) =>
      answerGuardianOffer(homeId, offer.offerId, { action: accept ? "accept" : "decline" }),
    onSuccess: (outcome, { offer }) => {
      setNotice(
        outcome === "accepted" ? t("offerAccepted", { name: offer.childName }) : t("offerDeclined"),
      );
      router.refresh();
    },
    onError: () => {
      router.refresh();
    },
  });
  if (offers.length === 0 && notice === null) return null;

  return (
    <Card title={t("offersTitle")} headingLevel={2} className="mb-6">
      <ul className="flex flex-col gap-4" data-testid="guardian-offers">
        {offers.map((offer) => (
          <li key={offer.offerId} className="flex flex-col gap-2">
            <p className="text-body text-fg">
              {offer.role === "primary"
                ? t("offerPrimary", { name: offer.childName })
                : t("offerSecondary", { name: offer.childName })}{" "}
              <span className="text-fg-muted">{t("offerExpires", { date: offer.expires })}</span>
            </p>
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                disabled={!hydrated || mutation.isPending}
                onClick={() => {
                  setNotice(null);
                  mutation.mutate({ offer, accept: true });
                }}
              >
                {t("acceptOffer")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={!hydrated || mutation.isPending}
                onClick={() => {
                  setNotice(null);
                  mutation.mutate({ offer, accept: false });
                }}
              >
                {t("declineOffer")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <MemberFailureAlert failure={mutation.error?.failure ?? null} className="mt-4" />
      {notice ? (
        <FormAlert tone="success" announce className="mt-4">
          {notice}
        </FormAlert>
      ) : null}
    </Card>
  );
}
