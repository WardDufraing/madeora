"use client";

import { POINTS_LIMITS } from "@madeora/domain/points";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { useChoreMutation } from "@/components/chores/use-chore-mutation";
import { useChoreTexts } from "@/components/chores/use-chore-texts";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { sendChoreRequest } from "@/chores/api";
import { normalizeShortText } from "@/chores/schema";
import {
  REWARD_REDEMPTIONS_ENDPOINT,
  type Redemption,
  type RewardMutationResult,
} from "@/points/api";
import { memberNames, type MemberOption } from "@/tasks/format";

import { ActionDialog } from "./action-dialog";

type Length = "ok" | "short" | "long";
function textLength(value: string, min: number, max: number): Length {
  const length = Array.from(normalizeShortText(value) ?? "").length;
  return length < min ? "short" : length > max ? "long" : "ok";
}

/**
 * Approving a request (S23; reviewers, never the requester). When the reward became unavailable
 * since the request, the database asks for confirmation first; the reviewer then approves anyway
 * or rejects.
 */
function Approve({
  redemption,
  members,
}: {
  readonly redemption: Redemption;
  readonly members: readonly MemberOption[];
}) {
  const t = useTranslations("Rewards");
  const texts = useChoreTexts(memberNames(members));
  const { announce, region } = useAnnouncer();
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const mutation = useChoreMutation(
    `redemption:${redemption.id}`,
    (confirm: boolean) =>
      sendChoreRequest<RewardMutationResult>(
        "PATCH",
        `${REWARD_REDEMPTIONS_ENDPOINT}/${redemption.id}`,
        { action: "approve", expectedRevision: redemption.revision, confirm },
      ),
    () => {
      announce(t("approvedAnnounce"));
    },
    {
      onError: (error) => {
        if (error.failure === "rewardUnavailable") setNeedsConfirm(true);
      },
    },
  );
  return (
    <>
      {region}
      <Button
        size="sm"
        loading={mutation.busy}
        onClick={() => {
          mutation.mutate(needsConfirm);
        }}
        aria-label={t("approveFor", {
          reward: redemption.rewardName,
          person: texts.person(redemption.requester),
        })}
        data-testid="redemption-approve"
      >
        {needsConfirm ? t("approveAnyway") : t("approve")}
      </Button>
      {mutation.error ? (
        <FormAlert tone="error" announce>
          {texts.failure(mutation.error.failure, mutation.error.detail)}
        </FormAlert>
      ) : null}
    </>
  );
}

/**
 * What the viewer may do with one redemption (S23), as the database said (`can` flags): approve
 * or reject someone else's request, cancel a pending one (a rewards manager gives a reason), mark
 * fulfillment (a correction needs a reason), resolve an unable-to-fulfill case with a refund or an
 * agreed replacement (preview first), and record the replacement's outcome.
 */
export function RedemptionActions({
  redemption,
  members,
}: {
  readonly redemption: Redemption;
  readonly members: readonly MemberOption[];
}) {
  const t = useTranslations("Rewards");
  const names = memberNames(members);
  const url = `${REWARD_REDEMPTIONS_ENDPOINT}/${redemption.id}`;
  const scope = `redemption:${redemption.id}`;
  const own = redemption.requester?.me ?? false;
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [replacement, setReplacement] = useState("");
  const [responsible, setResponsible] = useState("");
  const [resolution, setResolution] = useState<"refund" | "replacement">("refund");
  const [shown, setShown] = useState(false);
  const reset = () => {
    setReason("");
    setNote("");
    setReplacement("");
    setResponsible("");
    setResolution("refund");
    setShown(false);
  };
  const noteOk = textLength(note, 0, POINTS_LIMITS.reason) !== "long";
  const noteField = (label: string, testId: string) => (
    <TextArea
      label={label}
      rows={2}
      value={note}
      onChange={(event) => {
        setNote(event.target.value);
      }}
      error={shown && !noteOk ? t("fieldTooLong") : undefined}
      data-testid={testId}
    />
  );
  const reasonCheck = textLength(reason, POINTS_LIMITS.reasonMin, POINTS_LIMITS.reason);
  const reasonField = (testId: string) => (
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
      data-testid={testId}
    />
  );
  const fulfillment = (state: "fulfilled" | "unable" | "pending", correction: boolean) => (
    <ActionDialog<RewardMutationResult>
      scope={scope}
      method="PATCH"
      url={url}
      label={t(`fulfil_${state}`)}
      title={t(`fulfilTitle_${state}`, { reward: redemption.rewardName })}
      {...(correction ? { description: t("fulfilCorrectionBody") } : {})}
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
        correction
          ? reasonField("redemption-fulfil-reason")
          : noteField(t("fieldNote"), "redemption-fulfil-note")
      }
      names={names}
      testId={`redemption-fulfil-${state}`}
    />
  );

  return (
    <div className="flex flex-wrap items-start gap-2">
      {redemption.canApprove ? (
        <>
          <Approve redemption={redemption} members={members} />
          <ActionDialog<RewardMutationResult>
            scope={scope}
            method="PATCH"
            url={url}
            label={t("reject")}
            title={t("rejectTitle", { reward: redemption.rewardName })}
            description={t("rejectBody")}
            confirmLabel={t("reject")}
            announcement={() => t("rejectedAnnounce")}
            previewed={false}
            onOpen={reset}
            build={() => {
              setShown(true);
              if (!noteOk) return null;
              return {
                action: "reject",
                expectedRevision: redemption.revision,
                reason: normalizeShortText(note),
              };
            }}
            fields={noteField(t("fieldReasonOptional"), "redemption-reject-reason")}
            names={names}
            testId="redemption-reject"
          />
        </>
      ) : null}
      {redemption.canCancel ? (
        <ActionDialog<RewardMutationResult>
          scope={scope}
          method="PATCH"
          url={url}
          label={t("cancelRequest")}
          title={t("cancelTitle", { reward: redemption.rewardName })}
          description={own ? t("cancelOwnBody") : t("cancelOtherBody")}
          confirmLabel={t("cancelRequest")}
          announcement={() => t("cancelledAnnounce")}
          previewed={false}
          variant="ghost"
          onOpen={reset}
          build={() => {
            setShown(true);
            if (!own && reasonCheck !== "ok") return null;
            return {
              action: "cancel",
              expectedRevision: redemption.revision,
              reason: own ? null : normalizeShortText(reason),
            };
          }}
          {...(own ? {} : { fields: reasonField("redemption-cancel-reason") })}
          names={names}
          testId="redemption-cancel"
        />
      ) : null}
      {redemption.canFulfil ? (
        redemption.fulfillment === "pending" ? (
          <>
            {fulfillment("fulfilled", false)}
            {fulfillment("unable", false)}
          </>
        ) : (
          <>
            {fulfillment("pending", true)}
            {fulfillment(redemption.fulfillment === "fulfilled" ? "unable" : "fulfilled", true)}
          </>
        )
      ) : null}
      {redemption.canResolve ? (
        <ActionDialog<RewardMutationResult>
          scope={scope}
          method="PATCH"
          url={url}
          label={t("resolve")}
          title={t("resolveTitle", { reward: redemption.rewardName })}
          description={t("resolveBody")}
          confirmLabel={t("resolveConfirm")}
          announcement={() => t("resolvedAnnounce")}
          onOpen={reset}
          build={() => {
            setShown(true);
            const replacementText = normalizeShortText(replacement);
            if (!noteOk) return null;
            if (
              resolution === "replacement" &&
              (replacementText === null ||
                Array.from(replacementText).length > POINTS_LIMITS.replacement ||
                responsible === "")
            ) {
              return null;
            }
            return {
              action: "resolve",
              expectedRevision: redemption.revision,
              resolution,
              note: normalizeShortText(note),
              replacement: resolution === "replacement" ? replacementText : null,
              responsible: resolution === "replacement" ? responsible : null,
            };
          }}
          renderPreview={() => (
            <p className="text-body text-fg">
              {resolution === "refund"
                ? t("resolveRefundPreview", { points: redemption.cost })
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
                  { value: "replacement", label: t("resolution_replacement") },
                ]}
                data-testid="redemption-resolution"
              />
              {resolution === "replacement" ? (
                <>
                  <TextField
                    label={t("fieldReplacement")}
                    value={replacement}
                    onChange={(event) => {
                      setReplacement(event.target.value);
                    }}
                    error={
                      shown &&
                      (normalizeShortText(replacement) === null ||
                        Array.from(normalizeShortText(replacement) ?? "").length >
                          POINTS_LIMITS.replacement)
                        ? t("fieldReplacementInvalid")
                        : undefined
                    }
                    data-testid="redemption-replacement"
                  />
                  <SelectField
                    label={t("fieldResponsible")}
                    value={responsible}
                    onChange={(event) => {
                      setResponsible(event.target.value);
                    }}
                    options={[
                      { value: "", label: t("chooseResponsible") },
                      ...members.map((member) => ({
                        value: member.id,
                        label: member.isSelf ? t("you") : (member.name ?? t("unnamed")),
                      })),
                    ]}
                    data-testid="redemption-responsible"
                  />
                  {shown && responsible === "" ? (
                    <p className="text-helper text-danger" role="alert">
                      {t("fieldResponsibleRequired")}
                    </p>
                  ) : null}
                </>
              ) : null}
              {noteField(t("fieldNote"), "redemption-resolve-note")}
            </>
          }
          names={names}
          testId="redemption-resolve"
        />
      ) : null}
      {redemption.canSetReplacement
        ? (["fulfilled", "unable"] as const).map((state) => (
            <ActionDialog<RewardMutationResult>
              key={state}
              scope={scope}
              method="PATCH"
              url={url}
              label={t(`replacement_${state}`)}
              title={t(`replacementTitle_${state}`)}
              confirmLabel={t(`replacement_${state}`)}
              announcement={() => t("fulfilledAnnounce")}
              previewed={false}
              onOpen={reset}
              build={() => {
                setShown(true);
                if (!noteOk) return null;
                return {
                  action: "replacement",
                  expectedRevision: redemption.revision,
                  state,
                  note: normalizeShortText(note),
                };
              }}
              fields={noteField(t("fieldNote"), `redemption-replacement-${state}-note`)}
              names={names}
              testId={`redemption-replacement-${state}`}
            />
          ))
        : null}
    </div>
  );
}
