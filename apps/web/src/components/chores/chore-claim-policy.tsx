"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { RadioOption } from "@/components/settings/radio-option";
import { FormAlert } from "@/components/auth/form-alert";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import {
  CHORES_ENDPOINT,
  sendChoreRequest,
  type ChoreClaimPolicy,
  type ClaimPolicyImpact,
} from "@/chores/api";
import { CHORE_LIMITS, claimModes, expiryPolicies } from "@/chores/schema";
import { memberNames, type MemberOption } from "@/tasks/format";

import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

const formSchema = z
  .object({
    mode: z.enum(claimModes),
    memberIds: z.array(z.string()),
    expiry: z.enum(expiryPolicies),
    autoRelease: z.boolean(),
    hours: z.string(),
  })
  .superRefine((values, context) => {
    if (values.mode === "selected" && values.memberIds.length === 0) {
      context.addIssue({ code: "custom", message: "required", path: ["memberIds"] });
    }
    if (values.autoRelease) {
      const hours = Number(values.hours);
      if (
        values.hours.trim() === "" ||
        !Number.isInteger(hours) ||
        hours < 0 ||
        hours > CHORE_LIMITS.autoReleaseHours
      ) {
        context.addIssue({ code: "custom", message: "invalid", path: ["hours"] });
      }
    }
  });
type FormValues = z.infer<typeof formSchema>;

interface PolicyAnswer {
  readonly outcome: "preview" | "saved";
  readonly impact: ClaimPolicyImpact | null;
  readonly revision: number | null;
}

export interface ChoreClaimPolicyEditorProps {
  readonly choreId: string;
  readonly policy: ChoreClaimPolicy;
  readonly members: readonly MemberOption[];
}

/**
 * A chore's claim policies (S21, chore managers): who may claim its unassigned occurrences, whether
 * they close at the end of their week, and the automatic release of a claim not done in time. A
 * change is previewed first; when it closes or releases something at once, or leaves claims the
 * new rule would not allow, the manager sees that and confirms.
 */
export function ChoreClaimPolicyEditor({ choreId, policy, members }: ChoreClaimPolicyEditorProps) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(memberNames(members));
  const { announce, region } = useAnnouncer();
  const radioName = useId();
  const [open, setOpen] = useState(false);
  const [impact, setImpact] = useState<ClaimPolicyImpact | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const defaults: FormValues = {
    mode: policy.claimMode,
    memberIds: (policy.members ?? []).filter((id): id is string => id !== null),
    expiry: policy.expiryPolicy,
    autoRelease: policy.autoReleaseHours !== null,
    hours: String(policy.autoReleaseHours ?? 24),
  };
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: defaults });
  const close = () => {
    setOpen(false);
    setImpact(null);
    requestAnimationFrame(() => opener.current?.focus());
  };
  const send = (values: FormValues, dryRun: boolean) =>
    sendChoreRequest<PolicyAnswer>("PUT", `${CHORES_ENDPOINT}/${choreId}/claim-policy`, {
      expectedRevision: policy.revision,
      mode: values.mode,
      memberIds: values.mode === "selected" ? values.memberIds : [],
      expiry: values.expiry,
      autoReleaseHours: values.autoRelease ? Number(values.hours) : null,
      dryRun,
      confirm: !dryRun,
    });
  const save = useChoreMutation(
    `chore:${choreId}`,
    (values: FormValues) => send(values, false),
    () => {
      announce(t("announceSaved"));
      close();
    },
  );
  // A preview first: a change with effects at once is shown and confirmed, any other is saved.
  const preview = useChoreMutation(
    `chore:${choreId}`,
    (values: FormValues) => send(values, true),
    (answer, values) => {
      const next = answer.impact;
      if (next && next.expireNow + next.releaseNow + next.claimedIneligible > 0) {
        setImpact(next);
        announce(t("policyImpactShown"));
      } else {
        save.mutate(values);
      }
    },
    { refresh: () => false },
  );
  const busy = preview.busy || save.busy;
  const error = save.error ?? preview.error;
  const mode = useWatch({ control: form.control, name: "mode" });
  const chosen = useWatch({ control: form.control, name: "memberIds" });
  const autoRelease = useWatch({ control: form.control, name: "autoRelease" });
  const submit = form.handleSubmit((values) => {
    setImpact(null);
    save.reset();
    preview.mutate(values);
  });

  return (
    <section aria-labelledby="chore-claim-policy-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2 id="chore-claim-policy-heading" className="text-section-title font-semibold text-fg">
          {t("policyHeading")}
        </h2>
        {!open ? (
          <div>
            <Button
              ref={opener}
              variant="secondary"
              onClick={() => {
                form.reset(defaults);
                preview.reset();
                save.reset();
                setOpen(true);
              }}
              data-testid="chore-policy-edit"
            >
              {t("policyEdit")}
            </Button>
          </div>
        ) : (
          <form
            noValidate
            onSubmit={(event) => {
              void submit(event);
            }}
            className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
            data-testid="chore-policy-form"
          >
            <p className="text-helper text-fg-muted">{t("policyHelp")}</p>
            <fieldset className="flex flex-col gap-2">
              <legend className="text-body font-medium text-fg">{t("fieldClaimMode")}</legend>
              {claimModes.map((value) => (
                <RadioOption
                  key={value}
                  name={radioName}
                  value={value}
                  label={
                    value === "all"
                      ? t("claimModeAll")
                      : value === "selected"
                        ? t("claimModeSelected")
                        : t("claimModeNone")
                  }
                  checked={mode === value}
                  onChange={() => {
                    form.setValue("mode", value);
                  }}
                />
              ))}
              {mode === "selected" ? (
                <fieldset className="ms-8 flex flex-col gap-1">
                  <legend className="sr-only">{t("claimModeSelected")}</legend>
                  {members.map((member) => (
                    <Checkbox
                      key={member.id}
                      label={texts.person({ me: member.isSelf, member: member.id })}
                      checked={chosen.includes(member.id)}
                      disabled={
                        !chosen.includes(member.id) && chosen.length >= CHORE_LIMITS.members
                      }
                      onChange={(event) => {
                        form.setValue(
                          "memberIds",
                          event.target.checked
                            ? [...chosen, member.id]
                            : chosen.filter((id) => id !== member.id),
                        );
                      }}
                    />
                  ))}
                  {form.formState.errors.memberIds ? (
                    <FormAlert tone="error">{t("policyMembersRequired")}</FormAlert>
                  ) : null}
                </fieldset>
              ) : null}
            </fieldset>
            <SelectField
              label={t("fieldExpiry")}
              options={[
                { value: "overdue", label: t("expiryOverdue") },
                { value: "week_end", label: t("expiryWeekEnd") },
              ]}
              {...form.register("expiry")}
            />
            <Checkbox
              label={t("autoReleaseOn")}
              description={t("autoReleaseHelp")}
              {...form.register("autoRelease")}
            />
            {autoRelease ? (
              <TextField
                type="number"
                inputMode="numeric"
                min={0}
                max={CHORE_LIMITS.autoReleaseHours}
                label={t("autoReleaseHours")}
                error={form.formState.errors.hours ? t("autoReleaseHoursInvalid") : undefined}
                {...form.register("hours")}
              />
            ) : null}
            {impact ? (
              <div
                className="flex flex-col gap-1 rounded-card border border-line bg-surface-sunken p-3 text-body text-fg"
                data-testid="chore-policy-impact"
              >
                <p className="font-medium">{t("policyImpactTitle")}</p>
                {impact.expireNow > 0 ? (
                  <p>{t("policyImpactExpire", { count: impact.expireNow })}</p>
                ) : null}
                {impact.releaseNow > 0 ? (
                  <p>{t("policyImpactRelease", { count: impact.releaseNow })}</p>
                ) : null}
                {impact.claimedIneligible > 0 ? (
                  <p>{t("policyImpactIneligible", { count: impact.claimedIneligible })}</p>
                ) : null}
              </div>
            ) : null}
            {error ? (
              <FormAlert tone="error" announce>
                {texts.failure(error.failure)}
              </FormAlert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {impact ? (
                <Button
                  loading={busy}
                  onClick={() => {
                    save.mutate(form.getValues());
                  }}
                  data-testid="chore-policy-confirm"
                >
                  {t("policyConfirm")}
                </Button>
              ) : (
                <Button type="submit" loading={busy} data-testid="chore-policy-save">
                  {t("save")}
                </Button>
              )}
              <Button variant="secondary" onClick={close}>
                {t("cancel")}
              </Button>
            </div>
          </form>
        )}
      </HydrationGate>
    </section>
  );
}
