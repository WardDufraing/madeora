"use client";

import { POINTS_LIMITS } from "@madeora/domain/points";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { useChoreTexts } from "@/components/chores/use-chore-texts";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { normalizeShortText } from "@/chores/schema";
import {
  POINT_ADJUSTMENTS_ENDPOINT,
  POINT_ENTRIES_ENDPOINT,
  type AdjustmentResult,
} from "@/points/api";
import { signedPoints } from "@/points/format";
import type { MemberNames } from "@/tasks/format";

import { ActionDialog } from "./action-dialog";

/** A reason as the database counts it: 3-300 characters after whitespace runs read as one. */
function reasonProblem(reason: string): "reasonShort" | "reasonLong" | null {
  const text = normalizeShortText(reason) ?? "";
  const length = Array.from(text).length;
  if (length < POINTS_LIMITS.reasonMin) return "reasonShort";
  if (length > POINTS_LIMITS.reason) return "reasonLong";
  return null;
}

function AdjustmentPreviewView({
  result,
  names,
}: {
  readonly result: AdjustmentResult;
  readonly names: MemberNames;
}) {
  const t = useTranslations("Points");
  const texts = useChoreTexts(names);
  const preview = result.preview;
  if (!preview) return null;
  return (
    <dl className="grid gap-x-6 gap-y-1 rounded-card border border-line bg-surface-sunken p-3 text-body sm:grid-cols-[max-content_1fr]">
      <dt className="font-medium text-fg">{t("previewMember")}</dt>
      <dd className="text-fg">{texts.person(preview.person)}</dd>
      <dt className="font-medium text-fg">{t("previewChange")}</dt>
      <dd className="text-fg">{signedPoints(preview.amount)}</dd>
      <dt className="font-medium text-fg">{t("available")}</dt>
      <dd className="text-fg">{preview.available}</dd>
      <dt className="font-medium text-fg">{t("reserved")}</dt>
      <dd className="text-fg">{preview.reserved}</dd>
      <dt className="font-medium text-fg">{t("availableAfter")}</dt>
      <dd className="font-semibold text-fg">{preview.availableAfter}</dd>
    </dl>
  );
}

/**
 * A bonus or correction for one member (S23; points managers; spec "Confirmed manual reward point
 * bonuses and adjustments"): a meaningful reason, a preview of available points before and after,
 * then confirm. A debit never takes available points below zero or touches reserved points.
 */
export function AdjustPoints({
  homeId,
  memberId,
  memberLabel,
  names,
}: {
  readonly homeId: string;
  readonly memberId: string;
  readonly memberLabel: string;
  readonly names: MemberNames;
}) {
  const t = useTranslations("Points");
  const [id, setId] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<"bonus" | "correction">("bonus");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [shown, setShown] = useState(false);
  const value = Number(amount.trim());
  const amountOk =
    /^-?\d{1,6}$/.test(amount.trim()) &&
    value !== 0 &&
    Math.abs(value) <= POINTS_LIMITS.adjustment &&
    (kind === "correction" || value > 0);
  const problem = reasonProblem(reason);
  return (
    <ActionDialog<AdjustmentResult>
      scope={`points-account:${memberId}`}
      method="POST"
      url={POINT_ADJUSTMENTS_ENDPOINT}
      label={t("adjust")}
      ariaLabel={t("adjustFor", { person: memberLabel })}
      title={t("adjustTitle", { person: memberLabel })}
      description={t("adjustBody")}
      confirmLabel={t("adjustConfirm")}
      announcement={() => t("adjusted")}
      onOpen={() => {
        setId(crypto.randomUUID());
        setKind("bonus");
        setAmount("");
        setReason("");
        setShown(false);
      }}
      build={() => {
        setShown(true);
        if (!amountOk || problem) return null;
        return { id, homeId, memberId, kind, amount: value, reason };
      }}
      renderPreview={(result) => <AdjustmentPreviewView result={result} names={names} />}
      names={names}
      testId="points-adjust"
      fields={
        <>
          <SelectField
            label={t("fieldKind")}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value === "correction" ? "correction" : "bonus");
            }}
            options={[
              { value: "bonus", label: t("kind_bonus") },
              { value: "correction", label: t("kind_correction") },
            ]}
            data-testid="points-adjust-kind"
          />
          <TextField
            type="number"
            inputMode="numeric"
            label={t("fieldAmount")}
            description={
              kind === "bonus" ? t("fieldAmountBonusHelp") : t("fieldAmountCorrectionHelp")
            }
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
            }}
            error={shown && !amountOk ? t("fieldAmountInvalid") : undefined}
            data-testid="points-adjust-amount"
          />
          <TextArea
            label={t("fieldReasonRequired")}
            rows={2}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            error={
              shown && problem
                ? problem === "reasonShort"
                  ? t("fieldReasonMissing")
                  : t("fieldReasonInvalid")
                : undefined
            }
            data-testid="points-adjust-reason"
          />
        </>
      }
    />
  );
}

/** Reverses one bonus or correction with a linked entry (S23; points managers), with a reason. */
export function ReverseEntry({
  entryId,
  names,
}: {
  readonly entryId: string;
  readonly names: MemberNames;
}) {
  const t = useTranslations("Points");
  const [reason, setReason] = useState("");
  const [shown, setShown] = useState(false);
  const problem = reasonProblem(reason);
  return (
    <ActionDialog<AdjustmentResult>
      scope={`points-entry:${entryId}`}
      method="POST"
      url={`${POINT_ENTRIES_ENDPOINT}/${entryId}/reversal`}
      label={t("reverse")}
      title={t("reverseTitle")}
      description={t("reverseBody")}
      confirmLabel={t("reverseConfirm")}
      announcement={() => t("reversedAnnounce")}
      variant="ghost"
      onOpen={() => {
        setReason("");
        setShown(false);
      }}
      build={() => {
        setShown(true);
        return problem ? null : { reason };
      }}
      renderPreview={(result) => <AdjustmentPreviewView result={result} names={names} />}
      names={names}
      testId="points-reverse"
      fields={
        <TextArea
          label={t("fieldReasonRequired")}
          rows={2}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          error={
            shown && problem
              ? problem === "reasonShort"
                ? t("fieldReasonMissing")
                : t("fieldReasonInvalid")
              : undefined
          }
          data-testid="points-reverse-reason"
        />
      }
    />
  );
}
