"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { MemberFailureAlert } from "@/components/members/manage/member-failure-alert";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  answerGuardianOffer,
  assignChildGuardian,
  removeChildSecondaryGuardian,
} from "@/children/api";
import type { MemberActionError } from "@/members/manage-api";

import type { GuardianOption } from "./add-child-form";

type GuardianChange =
  | { readonly kind: "assign"; readonly role: "primary" | "secondary"; readonly id: string }
  | { readonly kind: "removeSecondary" }
  | { readonly kind: "withdraw"; readonly offerId: string };

/**
 * The child's guardians in this Home and what the viewer may change (S41; spec "Confirmed guardian
 * roles"): the primary guardian asks another adult to be secondary or to take over the primary
 * role; the secondary can step down; while the child has no primary guardian, the Owner asks
 * another adult (never themselves). A role applies only when the named adult accepts. Every other
 * member only sees who the guardians are and who was asked. The server decides again.
 */
export function ChildGuardians({
  homeId,
  membershipId,
  primaryName,
  secondaryName,
  hasSecondary,
  pendingPrimaryName,
  pendingSecondaryName,
  pendingPrimaryOfferId,
  pendingSecondaryOfferId,
  candidates,
  canAssignSecondary,
  canHandOverPrimary,
  canAppointPrimary,
  canRemoveSecondary,
  isSecondary,
}: {
  readonly homeId: string;
  readonly membershipId: string;
  readonly primaryName: string | null;
  readonly secondaryName: string | null;
  readonly hasSecondary: boolean;
  /** Adults asked who have not answered yet, and the offers the viewer may withdraw. */
  readonly pendingPrimaryName: string | null;
  readonly pendingSecondaryName: string | null;
  readonly pendingPrimaryOfferId: string | null;
  readonly pendingSecondaryOfferId: string | null;
  /** Adult members who may become a guardian, not counting the current primary. */
  readonly candidates: readonly GuardianOption[];
  readonly canAssignSecondary: boolean;
  readonly canHandOverPrimary: boolean;
  readonly canAppointPrimary: boolean;
  readonly canRemoveSecondary: boolean;
  readonly isSecondary: boolean;
}) {
  const t = useTranslations("Children");
  const router = useRouter();
  const hydrated = useHydrated();
  const [selected, setSelected] = useState(candidates[0]?.membershipId ?? "");
  const [done, setDone] = useState<"offered" | "withdrawn" | "saved" | null>(null);

  const mutation = useMutation<undefined, MemberActionError, GuardianChange>({
    mutationFn: async (change) => {
      if (change.kind === "assign") {
        await assignChildGuardian(homeId, membershipId, {
          role: change.role,
          guardianMembershipId: change.id,
        });
      } else if (change.kind === "withdraw") {
        await answerGuardianOffer(homeId, change.offerId, { action: "cancel" });
      } else {
        await removeChildSecondaryGuardian(homeId, membershipId);
      }
      return undefined;
    },
    onSuccess: (_, change) => {
      setDone(
        change.kind === "assign" ? "offered" : change.kind === "withdraw" ? "withdrawn" : "saved",
      );
      router.refresh();
    },
  });
  const run = (change: GuardianChange) => {
    setDone(null);
    if (!mutation.isPending) mutation.mutate(change);
  };
  const canPick = canAssignSecondary || canHandOverPrimary || canAppointPrimary;

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body">
        <dt className="text-fg-muted">{t("primaryGuardian")}</dt>
        <dd className="text-fg" data-testid="primary-guardian">
          {primaryName === null ? t("onHold") : <bdi>{primaryName}</bdi>}
        </dd>
        <dt className="text-fg-muted">{t("secondaryGuardian")}</dt>
        <dd className="text-fg" data-testid="secondary-guardian">
          {secondaryName === null ? t("noSecondary") : <bdi>{secondaryName}</bdi>}
        </dd>
      </dl>
      {pendingPrimaryName !== null || pendingSecondaryName !== null ? (
        <ul className="flex flex-col gap-2 text-body text-fg" data-testid="pending-guardians">
          {(
            [
              ["primary", pendingPrimaryName, pendingPrimaryOfferId],
              ["secondary", pendingSecondaryName, pendingSecondaryOfferId],
            ] as const
          ).map(([role, pendingName, offerId]) =>
            pendingName === null ? null : (
              <li key={role} className="flex flex-wrap items-center gap-3">
                <span>
                  {role === "primary"
                    ? t("pendingPrimary", { name: pendingName })
                    : t("pendingSecondary", { name: pendingName })}
                </span>
                {offerId !== null ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!hydrated}
                    loading={mutation.isPending}
                    onClick={() => {
                      run({ kind: "withdraw", offerId });
                    }}
                  >
                    {t("withdrawOffer")}
                  </Button>
                ) : null}
              </li>
            ),
          )}
        </ul>
      ) : null}
      {primaryName === null ? (
        <FormAlert tone="info">
          {canAppointPrimary ? t("onHoldOwner") : t("onHoldOthers")}
        </FormAlert>
      ) : null}
      {canPick && candidates.length > 0 ? (
        <div className="flex flex-col gap-3">
          <SelectField
            label={t("chooseGuardian")}
            options={candidates.map((option) => ({
              value: option.membershipId,
              label: option.name,
            }))}
            value={selected}
            onChange={(event) => {
              setSelected(event.target.value);
            }}
            disabled={!hydrated}
          />
          <div className="flex flex-wrap gap-3">
            {canAssignSecondary ? (
              <Button
                type="button"
                variant="secondary"
                disabled={!hydrated || selected === ""}
                loading={mutation.isPending}
                onClick={() => {
                  run({ kind: "assign", role: "secondary", id: selected });
                }}
              >
                {hasSecondary ? t("replaceSecondary") : t("makeSecondary")}
              </Button>
            ) : null}
            {canHandOverPrimary || canAppointPrimary ? (
              <Button
                type="button"
                variant="secondary"
                disabled={!hydrated || selected === ""}
                loading={mutation.isPending}
                onClick={() => {
                  run({ kind: "assign", role: "primary", id: selected });
                }}
              >
                {canAppointPrimary ? t("appointPrimary") : t("handOverPrimary")}
              </Button>
            ) : null}
          </div>
          {canHandOverPrimary ? (
            <p className="text-helper text-fg-muted">{t("handOverHint")}</p>
          ) : null}
        </div>
      ) : null}
      {canRemoveSecondary && hasSecondary ? (
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={!hydrated}
            loading={mutation.isPending}
            onClick={() => {
              run({ kind: "removeSecondary" });
            }}
          >
            {isSecondary ? t("stepDown") : t("removeSecondary")}
          </Button>
        </div>
      ) : null}
      <MemberFailureAlert failure={mutation.error?.failure ?? null} />
      {done !== null && !mutation.isPending ? (
        <FormAlert tone="success" announce>
          {done === "offered"
            ? t("offerSent")
            : done === "withdrawn"
              ? t("offerWithdrawn")
              : t("guardiansSaved")}
        </FormAlert>
      ) : null}
    </div>
  );
}
