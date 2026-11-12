"use client";

import {
  childCapabilities,
  childPresetCapabilities,
  childPresets,
  compareChildAccess,
  effectiveChildCapabilities,
  type ChildCapability,
  type ChildOverrides,
  type ChildPreset,
  type GuardianRole,
} from "@madeora/domain/permissions";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { MemberFailureAlert } from "@/components/members/manage/member-failure-alert";
import { RadioOption } from "@/components/settings/radio-option";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { useHydrated } from "@/components/ui/use-hydrated";
import { setChildAccess, type AccessResponse } from "@/children/api";
import type { MemberActionError } from "@/members/manage-api";

export const presetKey = {
  young_child: "presetYoungChild",
  child: "presetChild",
  teen: "presetTeen",
} as const satisfies Record<ChildPreset, string>;

export const capabilityKey = {
  viewHomeChores: "capViewHomeChores",
  viewHomeCalendar: "capViewHomeCalendar",
  viewLeaderboard: "capViewLeaderboard",
  claimPoolChores: "capClaimPoolChores",
  redeemRewards: "capRedeemRewards",
  viewShopping: "capViewShopping",
  editShopping: "capEditShopping",
  viewMeals: "capViewMeals",
  viewRecipes: "capViewRecipes",
  viewPets: "capViewPets",
  editOwnAvatar: "capEditOwnAvatar",
  editOwnDisplayName: "capEditOwnDisplayName",
} as const satisfies Record<ChildCapability, string>;

/** The overrides that make `wanted` the effective set on `preset`: only differences are kept. */
function overridesFor(preset: ChildPreset, wanted: ReadonlySet<ChildCapability>): ChildOverrides {
  const fromPreset = new Set<ChildCapability>(childPresetCapabilities[preset]);
  const result: Partial<Record<ChildCapability, boolean>> = {};
  for (const capability of childCapabilities) {
    if (wanted.has(capability) !== fromPreset.has(capability)) {
      result[capability] = wanted.has(capability);
    }
  }
  return result;
}

/**
 * A child's access in this Home (S41; spec "Confirmed age-appropriate child permission presets"):
 * a preset, explained before it applies, plus explicit switches that survive a preset change.
 * Every change shows what is added and removed; a change that adds anything asks for explicit
 * confirmation. The secondary guardian may only switch things off. These settings take effect when
 * the child can sign in (S42); nothing here enables sign-in or a dashboard.
 */
export function ChildAccessForm({
  homeId,
  membershipId,
  childName,
  guardianRole,
  preset: savedPreset,
  overrides: savedOverrides,
  updatedAt,
}: {
  readonly homeId: string;
  readonly membershipId: string;
  readonly childName: string;
  readonly guardianRole: GuardianRole;
  readonly preset: ChildPreset;
  readonly overrides: ChildOverrides;
  readonly updatedAt: string;
}) {
  const t = useTranslations("Children");
  const router = useRouter();
  const hydrated = useHydrated();
  const primary = guardianRole === "primary";
  const [preset, setPreset] = useState<ChildPreset>(savedPreset);
  const [overrides, setOverrides] = useState<ChildOverrides>(savedOverrides);
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState(false);

  const before = effectiveChildCapabilities(savedPreset, savedOverrides);
  const after = effectiveChildCapabilities(preset, overrides);
  const change = compareChildAccess(before, after);
  const dirty = change.added.length > 0 || change.removed.length > 0 || preset !== savedPreset;
  const afterSet = new Set(after);
  const beforeSet = new Set(before);

  const mutation = useMutation<AccessResponse, MemberActionError, boolean>({
    mutationFn: (confirmExpansion) =>
      setChildAccess(homeId, membershipId, {
        preset,
        overrides,
        confirmExpansion,
        expectedUpdatedAt: updatedAt,
      }),
    onSuccess: () => {
      setConfirming(false);
      setSaved(true);
      router.refresh();
    },
    onError: () => {
      setConfirming(false);
    },
  });

  const toggle = (capability: ChildCapability, on: boolean) => {
    setSaved(false);
    const wanted = new Set(afterSet);
    if (on) wanted.add(capability);
    else wanted.delete(capability);
    setOverrides(overridesFor(preset, wanted));
  };

  const changeList = (testId?: string) => (
    <ul className="flex list-disc flex-col gap-1 ps-5 text-body text-fg" data-testid={testId}>
      {change.added.map((capability) => (
        <li key={`+${capability}`}>{t("previewAdded", { item: t(capabilityKey[capability]) })}</li>
      ))}
      {change.removed.map((capability) => (
        <li key={`-${capability}`}>
          {t("previewRemoved", { item: t(capabilityKey[capability]) })}
        </li>
      ))}
    </ul>
  );

  return (
    <form
      method="post"
      noValidate
      className="flex flex-col gap-5"
      data-testid="child-access-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!dirty || mutation.isPending) return;
        mutation.reset();
        if (change.widens) setConfirming(true);
        else mutation.mutate(false);
      }}
    >
      <p className="text-helper text-fg-muted">{t("accessTakesEffect")}</p>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-body font-medium text-fg">{t("presetLegend")}</legend>
        {childPresets.map((option) => (
          <RadioOption
            key={option}
            name="preset"
            value={option}
            checked={preset === option}
            disabled={!hydrated || !primary}
            label={t(presetKey[option])}
            description={childPresetCapabilities[option]
              .map((capability) => t(capabilityKey[capability]))
              .join(", ")}
            onChange={() => {
              setSaved(false);
              setPreset(option);
            }}
          />
        ))}
        {!primary ? <p className="text-helper text-fg-muted">{t("presetPrimaryOnly")}</p> : null}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-body font-medium text-fg">{t("capabilitiesLegend")}</legend>
        {childCapabilities.map((capability) => (
          <Checkbox
            key={capability}
            label={t(capabilityKey[capability])}
            checked={afterSet.has(capability)}
            // A secondary guardian may only switch off what is on now.
            disabled={!hydrated || (!primary && !beforeSet.has(capability))}
            onChange={(event) => {
              toggle(capability, event.target.checked);
            }}
          />
        ))}
      </fieldset>
      {Object.keys(overrides).length > 0 && primary ? (
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={!hydrated}
            onClick={() => {
              setSaved(false);
              setOverrides({});
            }}
          >
            {t("restoreDefaults")}
          </Button>
        </div>
      ) : null}
      {dirty ? (
        <div className="flex flex-col gap-2">
          <p className="text-body font-medium text-fg">{t("previewTitle")}</p>
          {change.added.length + change.removed.length > 0 ? (
            changeList("access-preview")
          ) : (
            <p className="text-body text-fg">{t("previewNoChange")}</p>
          )}
        </div>
      ) : null}
      <MemberFailureAlert failure={mutation.error?.failure ?? null} />
      {saved && !dirty ? (
        <FormAlert tone="success" announce>
          {t("accessSaved")}
        </FormAlert>
      ) : null}
      <div>
        <Button
          type="submit"
          disabled={!hydrated || !dirty}
          loading={mutation.isPending && !confirming}
        >
          {t("saveAccess")}
        </Button>
      </div>
      <Dialog
        open={confirming}
        onClose={() => {
          if (!mutation.isPending) setConfirming(false);
        }}
        closeLabel={t("close")}
        title={t("confirmWidenTitle", { name: childName })}
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={mutation.isPending}
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              loading={mutation.isPending}
              onClick={() => {
                if (!mutation.isPending) mutation.mutate(true);
              }}
            >
              {t("confirmWiden")}
            </Button>
          </>
        }
      >
        <p className="mb-2 text-body text-fg">{t("confirmWidenBody")}</p>
        {changeList()}
      </Dialog>
    </form>
  );
}
