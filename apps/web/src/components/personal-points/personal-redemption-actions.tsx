"use client";

import { POINTS_LIMITS } from "@madeora/domain/points";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { ActionDialog } from "@/components/points/action-dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { normalizeShortText } from "@/chores/schema";
import {
  PERSONAL_REWARD_REDEMPTIONS_ENDPOINT,
  type PersonalMutationResult,
  type PersonalRedemption,
} from "@/points/personal-api";
import { noMembers } from "@/tasks/format";

type Length = "ok" | "short" | "long";
function textLength(value: string, min: number, max: number): Length {
  const length = Array.from(normalizeShortText(value) ?? "").length;
  return length < min ? "short" : length > max ? "long" : "ok";
}

/**
 * What the owner does with one of their own redemptions (S28b): mark it fulfilled or unable to
 * fulfill, correct a mistaken state with a reason, and resolve Unable to fulfill once with a refund
 * of the cost or a replacement they chose. A resolved redemption is final.
 */
export function PersonalRedemptionActions({
  redemption,
}: {
  readonly redemption: PersonalRedemption;
}) {
  const t = useTranslations("Rewards");
  const tp = useTranslations("PersonalPoints");
  const url = `${PERSONAL_REWARD_REDEMPTIONS_ENDPOINT}/${redemption.id}`;
  const scope = `personal-redemption:${redemption.id}`;
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [replacement, setReplacement] = useState("");
  const [resolution, setResolution] = useState<"refund" | "replacement">("refund");
  const [shown, setShown] = useState(false);
  const reset = () => {
    setNote("");
    setReason("");
    setReplacement("");
    setResolution("refund");
    setShown(false);
  };
  if (redemption.resolution !== null) return null;
  const noteOk = textLength(note, 0, POINTS_LIMITS.reason) !== "long";
  const reasonCheck = textLength(reason, POINTS_LIMITS.reasonMin, POINTS_LIMITS.reason);
  const replacementCheck = textLength(replacement, 1, POINTS_LIMITS.replacement);
  const noteField = (testId: string) => (
    <TextArea
      label={t("fieldNote")}
      rows={2}
      value={note}
      onChange={(event) => {
        setNote(event.target.value);
      }}
      error={shown && !noteOk ? t("fieldTooLong") : undefined}
      data-testid={testId}
    />
  );
  const fulfillment = (state: "fulfilled" | "unable" | "pending", correction: boolean) => (
    <ActionDialog<PersonalMutationResult>
      key={state}
      scope={scope}
      method="PATCH"
      url={url}
      label={t(`fulfil_${state}`)}
      ariaLabel={`${t(`fulfil_${state}`)}: ${redemption.rewardName}`}
      title={t(`fulfilTitle_${state}`, { reward: redemption.rewardName })}
      {...(correction ? { description: tp("fulfilCorrectionBody") } : {})}
      confirmLabel={t(`fulfil_${state}`)}
      announcement={() => t("fulfilledAnnounce")}
      previewed={false}
      variant={state === "fulfilled" ? "primary" : "secondary"}
      onOpen={reset}
      build={() => {
        setShown(true);
        if (correction ? reasonCheck !== "ok" : !noteOk) return null;
        return {
          action: "fulfillment",
          expectedRevision: redemption.revision,
          state,
          note: normalizeShortText(correction ? reason : note),
        };
      }}
      fields={
        correction ? (
          <TextArea
            label={t("fieldReason")}
            rows={2}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            error={
              shown && reasonCheck !== "ok"
                ? reasonCheck === "short"
                  ? t("fieldReasonMissing")
                  : t("fieldTooLong")
                : undefined
            }
            data-testid="personal-fulfil-reason"
          />
        ) : (
          noteField("personal-fulfil-note")
        )
      }
      names={noMembers}
      testId={`personal-fulfil-${state}`}
    />
  );

  return (
    <div className="flex flex-wrap items-start gap-2">
      {redemption.fulfillment === "pending" ? (
        <>
          {fulfillment("fulfilled", false)}
          {fulfillment("unable", false)}
        </>
      ) : (
        <>
          {fulfillment("pending", true)}
          {fulfillment(redemption.fulfillment === "fulfilled" ? "unable" : "fulfilled", true)}
        </>
      )}
      {redemption.fulfillment === "unable" ? (
        <ActionDialog<PersonalMutationResult>
          scope={scope}
          method="PATCH"
          url={url}
          label={t("resolve")}
          ariaLabel={`${t("resolve")}: ${redemption.rewardName}`}
          title={t("resolveTitle", { reward: redemption.rewardName })}
          description={tp("resolveBody")}
          confirmLabel={t("resolveConfirm")}
          announcement={() => t("resolvedAnnounce")}
          onOpen={reset}
          build={() => {
            setShown(true);
            if (!noteOk) return null;
            if (resolution === "replacement" && replacementCheck !== "ok") return null;
            return {
              action: "resolve",
              expectedRevision: redemption.revision,
              resolution,
              note: normalizeShortText(note),
              replacement: resolution === "replacement" ? normalizeShortText(replacement) : null,
            };
          }}
          renderPreview={() => (
            <p className="text-body text-fg" data-testid="personal-resolve-preview">
              {resolution === "refund"
                ? tp("resolveRefundPreview", { points: redemption.cost })
                : t("resolveReplacementPreview")}
            </p>
          )}
          fields={
            <>
              <SelectField
                label={t("fieldResolution")}
                value={resolution}
                onChange={(event) => {
                  setResolution(event.target.value === "replacement" ? "replacement" : "refund");
                }}
                options={[
                  { value: "refund", label: t("resolution_refund", { points: redemption.cost }) },
                  { value: "replacement", label: tp("resolution_replacement") },
                ]}
                data-testid="personal-resolution"
              />
              {resolution === "replacement" ? (
                <TextField
                  label={t("fieldReplacement")}
                  value={replacement}
                  onChange={(event) => {
                    setReplacement(event.target.value);
                  }}
                  error={
                    shown && replacementCheck !== "ok" ? t("fieldReplacementInvalid") : undefined
                  }
                  data-testid="personal-replacement"
                />
              ) : null}
              {noteField("personal-resolve-note")}
            </>
          }
          names={noMembers}
          testId="personal-resolve"
        />
      ) : null}
    </div>
  );
}
