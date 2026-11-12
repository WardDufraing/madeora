"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { setSharedDevicePinRule } from "@/child-sign-in/api";
import { FormAlert } from "@/components/auth/form-alert";
import { MemberFailureAlert } from "@/components/members/manage/member-failure-alert";
import { Checkbox } from "@/components/ui/checkbox";
import { useHydrated } from "@/components/ui/use-hydrated";
import type { MemberActionError } from "@/members/manage-api";

/**
 * Whether this Home asks for a PIN for every chore confirmed on its household devices (S42 part
 * 2). Off: whoever records a chore just names the person who did it, and may still confirm with
 * their own PIN. The switch saves at once.
 */
export function SharedDevicePinRule({
  homeId,
  requirePin,
}: {
  readonly homeId: string;
  readonly requirePin: boolean;
}) {
  const t = useTranslations("ChildSignIn");
  const router = useRouter();
  const hydrated = useHydrated();
  const [value, setValue] = useState(requirePin);
  const [saved, setSaved] = useState(false);
  const save = useMutation<undefined, MemberActionError, boolean>({
    mutationFn: async (next) => {
      await setSharedDevicePinRule(homeId, { requirePin: next });
      return undefined;
    },
    onSuccess: () => {
      setSaved(true);
      router.refresh();
    },
    onError: (_error, next) => {
      setValue(!next);
    },
  });

  return (
    <div className="flex flex-col gap-3" data-testid="shared-device-pin-rule">
      <Checkbox
        label={t("pinRuleLabel")}
        description={t("pinRuleHint")}
        checked={value}
        disabled={!hydrated || save.isPending}
        onChange={(event) => {
          const next = event.target.checked;
          setValue(next);
          setSaved(false);
          save.mutate(next);
        }}
      />
      <MemberFailureAlert failure={save.error?.failure ?? null} />
      {saved ? (
        <FormAlert tone="success" announce>
          {t("pinRuleSaved")}
        </FormAlert>
      ) : null}
    </div>
  );
}
