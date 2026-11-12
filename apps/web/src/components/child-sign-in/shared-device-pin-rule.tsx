"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { setSharedDevicePinRule } from "@/child-sign-in/api";
import type { PinRuleInput } from "@/child-sign-in/schema";
import { FormAlert } from "@/components/auth/form-alert";
import { MemberFailureAlert } from "@/components/members/manage/member-failure-alert";
import { Checkbox } from "@/components/ui/checkbox";
import { useHydrated } from "@/components/ui/use-hydrated";
import type { MemberActionError } from "@/members/manage-api";

export interface PinTargetView {
  readonly id: string;
  readonly name: string;
  readonly required: boolean;
}

type RuleKey = "home" | `member:${string}` | `chore:${string}`;

function keyOf(rule: PinRuleInput): RuleKey {
  return "kind" in rule ? `${rule.kind}:${rule.targetId}` : "home";
}

/**
 * When this Home asks for a PIN for chores done on its household devices (S42 part 2): for every
 * chore, always for some members, or always for some chores. The stricter rule wins (spec). Off
 * everywhere: whoever records a chore names the person who did it, who may still confirm with
 * their own PIN. Each switch saves at once.
 */
export function SharedDevicePinRule({
  homeId,
  requirePin,
  members,
  chores,
}: {
  readonly homeId: string;
  readonly requirePin: boolean;
  readonly members: readonly PinTargetView[];
  readonly chores: readonly PinTargetView[];
}) {
  const t = useTranslations("ChildSignIn");
  const router = useRouter();
  const hydrated = useHydrated();
  const [values, setValues] = useState<ReadonlyMap<RuleKey, boolean>>(
    () =>
      new Map<RuleKey, boolean>([
        ["home", requirePin],
        ...members.map((m): [RuleKey, boolean] => [`member:${m.id}`, m.required]),
        ...chores.map((c): [RuleKey, boolean] => [`chore:${c.id}`, c.required]),
      ]),
  );
  const [saved, setSaved] = useState(false);
  const set = (rule: PinRuleInput) => {
    setValues((current) => new Map(current).set(keyOf(rule), rule.requirePin));
  };
  const save = useMutation<undefined, MemberActionError, PinRuleInput>({
    mutationFn: async (rule) => {
      await setSharedDevicePinRule(homeId, rule);
      return undefined;
    },
    onSuccess: () => {
      setSaved(true);
      router.refresh();
    },
    onError: (_error, rule) => {
      set({ ...rule, requirePin: !rule.requirePin });
    },
  });
  const toggle = (rule: PinRuleInput) => {
    set(rule);
    setSaved(false);
    save.mutate(rule);
  };
  const disabled = !hydrated || save.isPending;
  const homeWide = values.get("home") ?? false;

  return (
    <div className="flex flex-col gap-4" data-testid="shared-device-pin-rule">
      <Checkbox
        label={t("pinRuleLabel")}
        description={t("pinRuleHint")}
        checked={homeWide}
        disabled={disabled}
        onChange={(event) => {
          toggle({ requirePin: event.target.checked });
        }}
      />
      {homeWide ? null : (
        <>
          {members.length > 0 ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-body font-semibold text-fg">
                {t("pinRuleMembers")}
              </legend>
              {members.map((member) => (
                <Checkbox
                  key={member.id}
                  label={member.name}
                  checked={values.get(`member:${member.id}`) ?? false}
                  disabled={disabled}
                  onChange={(event) => {
                    toggle({
                      kind: "member",
                      targetId: member.id,
                      requirePin: event.target.checked,
                    });
                  }}
                />
              ))}
            </fieldset>
          ) : null}
          {chores.length > 0 ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-body font-semibold text-fg">{t("pinRuleChores")}</legend>
              {chores.map((chore) => (
                <Checkbox
                  key={chore.id}
                  label={chore.name}
                  checked={values.get(`chore:${chore.id}`) ?? false}
                  disabled={disabled}
                  onChange={(event) => {
                    toggle({ kind: "chore", targetId: chore.id, requirePin: event.target.checked });
                  }}
                />
              ))}
            </fieldset>
          ) : null}
        </>
      )}
      <MemberFailureAlert failure={save.error?.failure ?? null} />
      {saved ? (
        <FormAlert tone="success" announce>
          {t("pinRuleSaved")}
        </FormAlert>
      ) : null}
    </div>
  );
}
