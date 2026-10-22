"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { memberPeriods, POINTS_LIMITS } from "@madeora/domain/points";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { FormAlert } from "@/components/auth/form-alert";
import { useChoreFieldMessage } from "@/components/chores/chore-form";
import { useChoreMutation } from "@/components/chores/use-chore-mutation";
import { useChoreTexts } from "@/components/chores/use-chore-texts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { sendChoreRequest } from "@/chores/api";
import { nameSchema } from "@/chores/schema";
import {
  REWARD_REDEMPTIONS_ENDPOINT,
  REWARDS_ENDPOINT,
  type RedeemResult,
  type Reward,
  type RewardMutationResult,
} from "@/points/api";
import { noMembers } from "@/tasks/format";
import { dateOnlySchema, plainTextSchema } from "@/tasks/schema";

import { ActionDialog } from "./action-dialog";

/**
 * Redeeming a reward for oneself (S23; spec "Confirmed reward redemption" and "Confirmed optional
 * approval for reward redemption"): the preview shows the cost and the available points after;
 * confirming redeems at once, or sends a request that reserves the cost. A changed cost is refused
 * so the member sees the new one.
 */
export function RedeemReward({ reward }: { readonly reward: Reward }) {
  const t = useTranslations("Rewards");
  const [id, setId] = useState(() => crypto.randomUUID());
  const label = reward.requiresApproval ? t("request") : t("redeem");
  return (
    <ActionDialog<RedeemResult>
      scope={`reward-redeem:${reward.id}`}
      method="POST"
      url={REWARD_REDEMPTIONS_ENDPOINT}
      label={label}
      ariaLabel={t("redeemFor", { reward: reward.name, action: label })}
      variant="primary"
      title={t("redeemTitle", { reward: reward.name })}
      description={reward.requiresApproval ? t("requestBody") : t("redeemBody")}
      confirmLabel={label}
      announcement={(result) =>
        result.outcome === "requested" ? t("requestedAnnounce") : t("redeemedAnnounce")
      }
      onOpen={() => {
        setId(crypto.randomUUID());
      }}
      build={() => ({ id, rewardId: reward.id, expectedCost: reward.cost })}
      renderPreview={(result) =>
        result.detail ? (
          <dl className="grid gap-x-6 gap-y-1 rounded-card border border-line bg-surface-sunken p-3 text-body sm:grid-cols-[max-content_1fr]">
            <dt className="font-medium text-fg">{t("cost")}</dt>
            <dd className="text-fg">{result.detail.cost}</dd>
            <dt className="font-medium text-fg">{t("availableNow")}</dt>
            <dd className="text-fg">{result.detail.available}</dd>
            <dt className="font-medium text-fg">{t("availableAfter")}</dt>
            <dd className="font-semibold text-fg">{result.detail.availableAfter}</dd>
            {result.detail.requiresApproval && !result.detail.reviewerAvailable ? (
              <dd className="col-span-full font-semibold text-fg">{t("noReviewerWarning")}</dd>
            ) : null}
          </dl>
        ) : null
      }
      names={noMembers}
      testId="reward-redeem"
    />
  );
}

const optionalInt = (max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .refine(
      (value) =>
        value === "" || (/^\d{1,6}$/.test(value) && Number(value) >= 1 && Number(value) <= max),
      "invalid",
    )
    .transform((value) => (value === "" ? null : Number(value)));

const rewardFormSchema = z
  .object({
    name: nameSchema(POINTS_LIMITS.rewardName),
    description: z
      .string()
      .transform((value) => (value.trim() === "" ? null : value))
      .pipe(plainTextSchema(POINTS_LIMITS.rewardDescription).nullable()),
    cost: z
      .string()
      .transform((value) => value.trim())
      .refine(
        (value) =>
          /^\d{1,6}$/.test(value) && Number(value) >= 1 && Number(value) <= POINTS_LIMITS.cost,
        "invalid",
      )
      .transform(Number),
    requiresApproval: z.boolean(),
    enabled: z.boolean(),
    availableFrom: z.union([z.literal(""), dateOnlySchema]).transform((value) => value || null),
    availableUntil: z.union([z.literal(""), dateOnlySchema]).transform((value) => value || null),
    totalLimit: optionalInt(POINTS_LIMITS.totalLimit),
    memberLimit: optionalInt(POINTS_LIMITS.memberLimit),
    memberPeriod: z.enum(memberPeriods),
  })
  .refine(
    (reward) =>
      reward.availableFrom === null ||
      reward.availableUntil === null ||
      reward.availableUntil >= reward.availableFrom,
    { message: "invalid", path: ["availableUntil"] },
  );
type RewardFormInput = z.input<typeof rewardFormSchema>;
type RewardFormOutput = z.output<typeof rewardFormSchema>;

function draftOf(reward: Reward | null): RewardFormInput {
  return {
    name: reward?.name ?? "",
    description: reward?.description ?? "",
    cost: reward ? String(reward.cost) : "",
    requiresApproval: reward?.requiresApproval ?? false,
    enabled: reward?.enabled ?? true,
    availableFrom: reward?.availableFrom ?? "",
    availableUntil: reward?.availableUntil ?? "",
    totalLimit: reward?.totalLimit === null || !reward ? "" : String(reward.totalLimit),
    memberLimit: reward?.memberLimit === null || !reward ? "" : String(reward.memberLimit),
    memberPeriod: reward?.memberPeriod ?? "month",
  };
}

function fieldsOf(values: RewardFormOutput) {
  return {
    name: values.name,
    description: values.description,
    cost: values.cost,
    requiresApproval: values.requiresApproval,
    enabled: values.enabled,
    availableFrom: values.availableFrom,
    availableUntil: values.availableUntil,
    totalLimit: values.totalLimit,
    memberLimit: values.memberLimit,
    memberPeriod: values.memberLimit === null ? null : values.memberPeriod,
  };
}

/**
 * Creating or editing a reward (S23; rewards managers; spec "Confirmed reward catalog"): name,
 * description, cost, approval, on/off, availability window, total and per-member limits. Editing
 * previews the impact first: pending requests keep their cost and reservation, completed
 * redemptions never change, and lower limits apply to new requests only.
 */
export function RewardForm({
  homeId,
  reward,
}: {
  readonly homeId: string;
  readonly reward: Reward | null;
}) {
  const t = useTranslations("Rewards");
  const texts = useChoreTexts(noMembers);
  const message = useChoreFieldMessage();
  const [open, setOpen] = useState(false);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [impact, setImpact] = useState<{
    fields: ReturnType<typeof fieldsOf>;
    result: RewardMutationResult;
  } | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const { announce, region } = useAnnouncer();
  const form = useForm<RewardFormInput, unknown, RewardFormOutput>({
    resolver: zodResolver(rewardFormSchema),
    defaultValues: draftOf(reward),
  });
  const memberLimit = useWatch({ control: form.control, name: "memberLimit" });
  const mutation = useChoreMutation(
    reward ? `reward:${reward.id}` : `reward-create:${draftId}`,
    ({ fields, dryRun }: { fields: ReturnType<typeof fieldsOf>; dryRun: boolean }) =>
      reward
        ? sendChoreRequest<RewardMutationResult>("PATCH", `${REWARDS_ENDPOINT}/${reward.id}`, {
            action: "edit",
            expectedRevision: reward.revision,
            dryRun,
            ...fields,
          })
        : sendChoreRequest<RewardMutationResult>("POST", REWARDS_ENDPOINT, {
            id: draftId,
            homeId,
            ...fields,
          }),
    (result, { fields, dryRun }) => {
      if (dryRun) {
        setImpact({ fields, result });
        return;
      }
      announce(reward ? t("rewardSaved") : t("rewardCreated"));
      setImpact(null);
      setOpen(false);
      if (!reward) {
        setDraftId(crypto.randomUUID());
        form.reset(draftOf(null));
      }
      requestAnimationFrame(() => opener.current?.focus());
    },
    { refresh: (_result, { dryRun }) => !dryRun },
  );
  const errors = form.formState.errors;
  const invalid = (error: { readonly message?: string | undefined } | undefined) =>
    error ? (message(error) ?? t("fieldInvalid")) : undefined;
  const pending = impact?.result.impact?.pending;
  const redeemed = impact?.result.impact?.redeemed;

  if (!open) {
    return (
      <div>
        {region}
        <Button
          ref={opener}
          size="sm"
          variant={reward ? "secondary" : "primary"}
          onClick={() => {
            form.reset(draftOf(reward));
            setImpact(null);
            mutation.reset();
            setOpen(true);
          }}
          {...(reward ? { "aria-label": t("editRewardFor", { reward: reward.name }) } : {})}
          data-testid={reward ? "reward-edit-open" : "reward-new-open"}
        >
          {reward ? t("editReward") : t("newReward")}
        </Button>
      </div>
    );
  }
  return (
    <form
      noValidate
      onSubmit={(event) => {
        void form.handleSubmit((values) => {
          if (impact) {
            mutation.mutate({ fields: impact.fields, dryRun: false });
            return;
          }
          mutation.mutate({ fields: fieldsOf(values), dryRun: reward !== null });
        })(event);
      }}
      onChange={() => {
        setImpact(null);
      }}
      className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
      data-testid="reward-form"
    >
      {region}
      <TextField
        label={t("fieldName")}
        required
        autoComplete="off"
        maxLength={POINTS_LIMITS.rewardName * 2}
        error={invalid(errors.name)}
        data-testid="reward-name"
        {...form.register("name")}
      />
      <TextArea
        label={t("fieldDescription")}
        rows={2}
        error={invalid(errors.description)}
        {...form.register("description")}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          type="number"
          inputMode="numeric"
          min={1}
          max={POINTS_LIMITS.cost}
          label={t("fieldCost")}
          error={errors.cost ? t("fieldCostInvalid") : undefined}
          data-testid="reward-cost-input"
          {...form.register("cost")}
        />
        <TextField
          type="number"
          inputMode="numeric"
          min={1}
          max={POINTS_LIMITS.totalLimit}
          label={t("fieldTotalLimit")}
          description={t("fieldTotalLimitHelp")}
          error={errors.totalLimit ? t("fieldLimitInvalid") : undefined}
          {...form.register("totalLimit")}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          type="number"
          inputMode="numeric"
          min={1}
          max={POINTS_LIMITS.memberLimit}
          label={t("fieldMemberLimit")}
          description={t("fieldMemberLimitHelp")}
          error={errors.memberLimit ? t("fieldLimitInvalid") : undefined}
          {...form.register("memberLimit")}
        />
        {memberLimit.trim() !== "" ? (
          <SelectField
            label={t("fieldMemberPeriod")}
            options={memberPeriods.map((value) => ({ value, label: t(`memberPeriod_${value}`) }))}
            {...form.register("memberPeriod")}
          />
        ) : null}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          type="date"
          label={t("fieldAvailableFrom")}
          {...form.register("availableFrom")}
        />
        <TextField
          type="date"
          label={t("fieldAvailableUntil")}
          error={errors.availableUntil ? t("fieldUntilInvalid") : undefined}
          {...form.register("availableUntil")}
        />
      </div>
      <Checkbox
        label={t("fieldRequiresApproval")}
        description={t("fieldRequiresApprovalHelp")}
        data-testid="reward-requires-approval"
        {...form.register("requiresApproval")}
      />
      <Checkbox label={t("fieldEnabled")} {...form.register("enabled")} />
      {impact ? (
        <p
          className="rounded-card border border-line bg-surface-sunken p-3 text-body text-fg"
          data-testid="reward-impact"
        >
          {t("editImpact", {
            pending: typeof pending === "number" ? pending : 0,
            redeemed: typeof redeemed === "number" ? redeemed : 0,
          })}
        </p>
      ) : null}
      {mutation.error ? (
        <FormAlert tone="error" announce>
          {texts.failure(mutation.error.failure, mutation.error.detail)}
        </FormAlert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={mutation.busy} data-testid="reward-save">
          {reward ? (impact ? t("confirm") : t("preview")) : t("createReward")}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setOpen(false);
            requestAnimationFrame(() => opener.current?.focus());
          }}
        >
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}

/** Archiving a reward, or bringing it back (S23; rewards managers). */
export function ArchiveReward({ reward }: { readonly reward: Reward }) {
  const t = useTranslations("Rewards");
  const action = reward.archived ? "restore" : "archive";
  return (
    <ActionDialog<RewardMutationResult>
      scope={`reward:${reward.id}`}
      method="PATCH"
      url={`${REWARDS_ENDPOINT}/${reward.id}`}
      label={t(action)}
      ariaLabel={t(`${action}For`, { reward: reward.name })}
      variant="ghost"
      title={t(`${action}Title`, { reward: reward.name })}
      description={t(`${action}Body`)}
      confirmLabel={t(action)}
      announcement={() => t(`${action}dAnnounce`)}
      previewed={false}
      build={() => ({ action, expectedRevision: reward.revision })}
      names={noMembers}
      testId={`reward-${action}`}
    />
  );
}
