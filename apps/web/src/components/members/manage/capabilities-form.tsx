"use client";

import { delegableCapabilities, type DelegableCapability } from "@madeora/domain/permissions";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  setMemberCapabilities,
  type CapabilitiesResponse,
  type MemberActionError,
} from "@/members/manage-api";

import { MemberFailureAlert } from "./member-failure-alert";
import { useCapabilityLabels } from "./use-capability-labels";

/**
 * The Owner's editor for one Administrator's rights (S12; spec "Confirmed customizable
 * Administrator permissions"): each capability with what it allows, a live summary of what saving
 * would grant and take away, and a confirmation that lists both before anything changes.
 */
export function CapabilitiesForm({
  homeId,
  membershipId,
  memberName,
  granted,
}: {
  readonly homeId: string;
  readonly membershipId: string;
  readonly memberName: string;
  readonly granted: readonly DelegableCapability[];
}) {
  const t = useTranslations("Manage");
  const labels = useCapabilityLabels();
  const router = useRouter();
  const hydrated = useHydrated();
  const [chosen, setChosen] = useState<ReadonlySet<DelegableCapability>>(() => new Set(granted));
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // When the saved rights change (after saving, or a refresh shows someone else's change), the
  // choice starts again from them. Adjusted during render rather than by remounting, so the
  // confirmation that they were saved stays on screen.
  const grantedKey = granted.join(",");
  const [syncedKey, setSyncedKey] = useState(grantedKey);
  if (syncedKey !== grantedKey) {
    setSyncedKey(grantedKey);
    setChosen(new Set(granted));
  }

  const added = delegableCapabilities.filter((c) => chosen.has(c) && !granted.includes(c));
  const removed = delegableCapabilities.filter((c) => !chosen.has(c) && granted.includes(c));
  const changed = added.length > 0 || removed.length > 0;
  const list = (items: readonly DelegableCapability[]) =>
    items.length === 0 ? t("none") : items.map(labels.name).join(", ");

  const mutation = useMutation<CapabilitiesResponse, MemberActionError, DelegableCapability[]>({
    mutationFn: (capabilities) => setMemberCapabilities(homeId, membershipId, { capabilities }),
    onSuccess: ({ capabilities }) => {
      setConfirming(false);
      setChosen(new Set(capabilities));
      setNotice(t("capabilitiesSaved", { name: memberName }));
      router.refresh();
    },
    onError: () => {
      setConfirming(false);
      router.refresh();
    },
  });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed || mutation.isPending) return;
        setNotice(null);
        mutation.reset();
        setConfirming(true);
      }}
    >
      {notice ? (
        <FormAlert tone="success" announce>
          {notice}
        </FormAlert>
      ) : null}
      <MemberFailureAlert failure={mutation.error?.failure ?? null} />
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-body font-medium text-fg">
          {t("capabilitiesLegend", { name: memberName })}
        </legend>
        {delegableCapabilities.map((capability) => (
          <Checkbox
            key={capability}
            name="capabilities"
            value={capability}
            label={labels.name(capability)}
            description={labels.description(capability)}
            checked={chosen.has(capability)}
            onChange={(event) => {
              const next = new Set(chosen);
              if (event.target.checked) next.add(capability);
              else next.delete(capability);
              setChosen(next);
            }}
          />
        ))}
      </fieldset>
      <p
        className="text-helper text-fg-muted"
        aria-live="polite"
        data-testid="capabilities-preview"
      >
        {changed
          ? t("capabilitiesPreview", { added: list(added), removed: list(removed) })
          : t("capabilitiesNoChange")}
      </p>
      <div>
        <Button type="submit" disabled={!hydrated || !changed}>
          {t("saveCapabilities")}
        </Button>
      </div>

      <Dialog
        open={confirming}
        onClose={() => {
          if (!mutation.isPending) setConfirming(false);
        }}
        closeLabel={t("close")}
        title={t("capabilitiesConfirmTitle", { name: memberName })}
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
                if (!mutation.isPending) {
                  mutation.mutate(delegableCapabilities.filter((c) => chosen.has(c)));
                }
              }}
            >
              {t("capabilitiesConfirm")}
            </Button>
          </>
        }
      >
        <ul className="flex list-disc flex-col gap-1 ps-5 text-body text-fg">
          {added.length > 0 ? (
            <li>{t("capabilitiesConfirmGranted", { list: list(added) })}</li>
          ) : null}
          {removed.length > 0 ? (
            <li>{t("capabilitiesConfirmRemoved", { list: list(removed) })}</li>
          ) : null}
        </ul>
      </Dialog>
    </form>
  );
}
