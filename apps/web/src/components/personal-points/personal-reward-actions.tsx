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
import { ActionDialog } from "@/components/points/action-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { TextArea } from "@/components/ui/text-area";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { sendChoreRequest } from "@/chores/api";
import { nameSchema } from "@/chores/schema";
import {
  PERSONAL_REWARD_REDEMPTIONS_ENDPOINT,
  PERSONAL_REWARDS_ENDPOINT,
  type PersonalMutationResult,
  type PersonalRedeemResult,
  type PersonalReward,
} from "@/points/personal-api";
import { noMembers } from "@/tasks/format";
import { dateOnlySchema, plainTextSchema } from "@/tasks/schema";

/**
 * Redeeming one of the owner's own rewards (S28b): the preview shows the cost and the balance
 * after; confirming takes the cost at once. A changed cost is refused so the owner sees the new one.
 */
export function PersonalRedeem({ reward }: { readonly reward: PersonalReward }) {
  const t = useTranslations("Rewards");
  const [id, setId] = useState(() => crypto.randomUUID());
  return (
    <ActionDialog<PersonalRedeemResult>
      scope={`personal-reward-redeem:${reward.id}`}
      method="POST"
      url={PERSONAL_REWARD_REDEMPTIONS_ENDPOINT}
      label={t("redeem")}
      ariaLabel={t("redeemFor", { reward: reward.name, action: t("redeem") })}
      variant="primary"
      title={t("redeemTitle", { reward: reward.name })}
      description={t("redeemBody")}
      confirmLabel={t("redeem")}
      announcement={() => t("redeemedAnnounce")}
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
            <dd className="font-semibold text-fg" data-testid="personal-redeem-after">
              {result.detail.availableAfter}
            </dd>
          </dl>
        ) : null
      }
      names={noMembers}
      testId="personal-redeem"
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
    enabled: z.boolean(),
    availableFrom: z.union([z.literal(""), dateOnlySchema]).transform((value) => value || null),
    availableUntil: z.union([z.literal(""), dateOnlySchema]).transform((value) => value || null),
    totalLimit: optionalInt(POINTS_LIMITS.totalLimit),
    periodLimit: optionalInt(POINTS_LIMITS.memberLimit),
    limitPeriod: z.enum(memberPeriods),
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

function draftOf(reward: PersonalReward | null): RewardFormInput {
  return {
    name: reward?.name ?? "",
    description: reward?.description ?? "",
    cost: reward ? String(reward.cost) : "",
    enabled: reward?.enabled ?? true,
    availableFrom: reward?.availableFrom ?? "",
    availableUntil: reward?.availableUntil ?? "",
    totalLimit: reward?.totalLimit === null || !reward ? "" : String(reward.totalLimit),
    periodLimit: reward?.periodLimit === null || !reward ? "" : String(reward.periodLimit),
    limitPeriod: reward?.limitPeriod ?? "week",
  };
}

function fieldsOf(values: RewardFormOutput) {
  return {
    name: values.name,
    description: values.description,
    cost: values.cost,
    enabled: values.enabled,
    availableFrom: values.availableFrom,
    availableUntil: values.availableUntil,
    totalLimit: values.totalLimit,
    periodLimit: values.periodLimit,
    limitPeriod: values.periodLimit === null ? null : values.limitPeriod,
  };
}

/**
 * Defining or editing one of the owner's own rewards (S28b; self-defined only): name, description,
 * cost, on/off, availability window, total limit and a limit per week, month, year or ever. Editing
 * previews the impact first: past redemptions keep their cost, lower limits apply from now on.
 */
export function PersonalRewardForm({ reward }: { readonly reward: PersonalReward | null }) {
  const t = useTranslations("Rewards");
  const tp = useTranslations("PersonalPoints");
  const texts = useChoreTexts(noMembers);
  const message = useChoreFieldMessage();
  const [open, setOpen] = useState(false);
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [impact, setImpact] = useState<{
    fields: ReturnType<typeof fieldsOf>;
    result: PersonalMutationResult;
  } | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const { announce, region } = useAnnouncer();
  const form = useForm<RewardFormInput, unknown, RewardFormOutput>({
    resolver: zodResolver(rewardFormSchema),
    defaultValues: draftOf(reward),
  });
  const periodLimit = useWatch({ control: form.control, name: "periodLimit" });
  const mutation = useChoreMutation(
    reward ? `personal-reward:${reward.id}` : `personal-reward-create:${draftId}`,
    ({ fields, dryRun }: { fields: ReturnType<typeof fieldsOf>; dryRun: boolean }) =>
      reward
        ? sendChoreRequest<PersonalMutationResult>(
            "PATCH",
            `${PERSONAL_REWARDS_ENDPOINT}/${reward.id}`,
            { action: "edit", expectedRevision: reward.revision, dryRun, ...fields },
          )
        : sendChoreRequest<PersonalMutationResult>("POST", PERSONAL_REWARDS_ENDPOINT, {
            id: draftId,
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
          data-testid={reward ? "personal-reward-edit-open" : "personal-reward-new-open"}
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
      data-testid="personal-reward-form"
    >
      {region}
      <TextField
        label={t("fieldName")}
        required
        autoComplete="off"
        maxLength={POINTS_LIMITS.rewardName * 2}
        error={invalid(errors.name)}
        data-testid="personal-reward-name"
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
          data-testid="personal-reward-cost"
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
          label={tp("fieldPeriodLimit")}
          description={tp("fieldPeriodLimitHelp")}
          error={errors.periodLimit ? t("fieldLimitInvalid") : undefined}
          {...form.register("periodLimit")}
        />
        {periodLimit.trim() !== "" ? (
          <SelectField
            label={t("fieldMemberPeriod")}
            options={memberPeriods.map((value) => ({ value, label: tp(`period_${value}`) }))}
            {...form.register("limitPeriod")}
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
      <Checkbox label={tp("fieldEnabled")} {...form.register("enabled")} />
      {impact ? (
        <p
          className="rounded-card border border-line bg-surface-sunken p-3 text-body text-fg"
          data-testid="personal-reward-impact"
        >
          {tp("editImpact", { redeemed: typeof redeemed === "number" ? redeemed : 0 })}
        </p>
      ) : null}
      {mutation.error ? (
        <FormAlert tone="error" announce>
          {texts.failure(mutation.error.failure, mutation.error.detail)}
        </FormAlert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={mutation.busy} data-testid="personal-reward-save">
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

/** Archiving one of the owner's own rewards, or bringing it back (S28b). */
export function PersonalArchive({ reward }: { readonly reward: PersonalReward }) {
  const t = useTranslations("Rewards");
  const tp = useTranslations("PersonalPoints");
  const action = reward.archived ? "restore" : "archive";
  return (
    <ActionDialog<PersonalMutationResult>
      scope={`personal-reward:${reward.id}`}
      method="PATCH"
      url={`${PERSONAL_REWARDS_ENDPOINT}/${reward.id}`}
      label={t(action)}
      ariaLabel={t(`${action}For`, { reward: reward.name })}
      variant="ghost"
      title={t(`${action}Title`, { reward: reward.name })}
      description={action === "archive" ? tp("archiveBody") : t("restoreBody")}
      confirmLabel={t(action)}
      announcement={() => t(`${action}dAnnounce`)}
      previewed={false}
      build={() => ({ action, expectedRevision: reward.revision })}
      names={noMembers}
      testId={`personal-reward-${action}`}
    />
  );
}
