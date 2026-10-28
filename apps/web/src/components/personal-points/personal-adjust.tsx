"use client";

import { POINTS_LIMITS } from "@madeora/domain/points";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { ActionDialog } from "@/components/points/action-dialog";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { normalizeShortText } from "@/chores/schema";
import { signedPoints } from "@/points/format";
import {
  PERSONAL_POINT_ADJUSTMENTS_ENDPOINT,
  PERSONAL_POINT_ENTRIES_ENDPOINT,
  type PersonalAdjustmentResult,
} from "@/points/personal-api";
import { noMembers } from "@/tasks/format";

/** A reason as the database counts it: 3-300 characters after whitespace runs read as one. */
function reasonProblem(reason: string): "reasonShort" | "reasonLong" | null {
  const length = Array.from(normalizeShortText(reason) ?? "").length;
  if (length < POINTS_LIMITS.reasonMin) return "reasonShort";
  if (length > POINTS_LIMITS.reason) return "reasonLong";
  return null;
}

function PreviewView({ result }: { readonly result: PersonalAdjustmentResult }) {
  const t = useTranslations("Points");
  const preview = result.preview;
  if (!preview) return null;
  return (
    <dl className="grid gap-x-6 gap-y-1 rounded-card border border-line bg-surface-sunken p-3 text-body sm:grid-cols-[max-content_1fr]">
      <dt className="font-medium text-fg">{t("previewChange")}</dt>
      <dd className="text-fg">{signedPoints(preview.amount)}</dd>
      <dt className="font-medium text-fg">{t("available")}</dt>
      <dd className="text-fg">{preview.available}</dd>
      <dt className="font-medium text-fg">{t("availableAfter")}</dt>
      <dd className="font-semibold text-fg">{preview.availableAfter}</dd>
    </dl>
  );
}

function ReasonField({
  value,
  onChange,
  shown,
  testId,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly shown: boolean;
  readonly testId: string;
}) {
  const t = useTranslations("Points");
  const problem = reasonProblem(value);
  return (
    <TextArea
      label={t("fieldReasonRequired")}
      rows={2}
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      error={
        shown && problem
          ? problem === "reasonShort"
            ? t("fieldReasonMissing")
            : t("fieldReasonInvalid")
          : undefined
      }
      data-testid={testId}
    />
  );
}

/**
 * Adding points to one's own personal balance, or correcting it (S28b): a reason, a preview of the
 * balance before and after, then confirm. A correction never takes the balance below zero. Nothing
 * else posts personal points (no module awards them automatically).
 */
export function PersonalAdjust() {
  const t = useTranslations("PersonalPoints");
  const tp = useTranslations("Points");
  const [id, setId] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<"credit" | "correction">("credit");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [shown, setShown] = useState(false);
  const value = Number(amount.trim());
  const amountOk =
    /^-?\d{1,6}$/.test(amount.trim()) &&
    value !== 0 &&
    Math.abs(value) <= POINTS_LIMITS.adjustment &&
    (kind === "correction" || value > 0);
  return (
    <ActionDialog<PersonalAdjustmentResult>
      scope="personal-points"
      method="POST"
      url={PERSONAL_POINT_ADJUSTMENTS_ENDPOINT}
      label={t("adjust")}
      variant="primary"
      title={t("adjustTitle")}
      description={t("adjustBody")}
      confirmLabel={tp("adjustConfirm")}
      announcement={() => t("adjusted")}
      onOpen={() => {
        setId(crypto.randomUUID());
        setKind("credit");
        setAmount("");
        setReason("");
        setShown(false);
      }}
      build={() => {
        setShown(true);
        if (!amountOk || reasonProblem(reason)) return null;
        return { id, kind, amount: value, reason };
      }}
      renderPreview={(result) => <PreviewView result={result} />}
      names={noMembers}
      testId="personal-adjust"
      fields={
        <>
          <SelectField
            label={tp("fieldKind")}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value === "correction" ? "correction" : "credit");
            }}
            options={[
              { value: "credit", label: t("kind_credit") },
              { value: "correction", label: t("kind_correction") },
            ]}
            data-testid="personal-adjust-kind"
          />
          <TextField
            type="number"
            inputMode="numeric"
            label={tp("fieldAmount")}
            description={
              kind === "credit" ? tp("fieldAmountBonusHelp") : tp("fieldAmountCorrectionHelp")
            }
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
            }}
            error={shown && !amountOk ? t("fieldAmountInvalid") : undefined}
            data-testid="personal-adjust-amount"
          />
          <ReasonField
            value={reason}
            onChange={setReason}
            shown={shown}
            testId="personal-adjust-reason"
          />
        </>
      }
    />
  );
}

/** Reverses one of the owner's own credits or corrections with a linked entry, once, with a reason. */
export function PersonalReverse({ entryId }: { readonly entryId: string }) {
  const tp = useTranslations("Points");
  const [reason, setReason] = useState("");
  const [shown, setShown] = useState(false);
  return (
    <ActionDialog<PersonalAdjustmentResult>
      scope="personal-points"
      method="POST"
      url={`${PERSONAL_POINT_ENTRIES_ENDPOINT}/${entryId}/reversal`}
      label={tp("reverse")}
      title={tp("reverseTitle")}
      description={tp("reverseBody")}
      confirmLabel={tp("reverseConfirm")}
      announcement={() => tp("reversedAnnounce")}
      variant="ghost"
      onOpen={() => {
        setReason("");
        setShown(false);
      }}
      build={() => {
        setShown(true);
        return reasonProblem(reason) ? null : { reason };
      }}
      renderPreview={(result) => <PreviewView result={result} />}
      names={noMembers}
      testId="personal-reverse"
      fields={
        <ReasonField
          value={reason}
          onChange={setReason}
          shown={shown}
          testId="personal-reverse-reason"
        />
      }
    />
  );
}
