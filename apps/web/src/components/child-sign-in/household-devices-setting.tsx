"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { approveHouseholdDevice, revokeHouseholdDevice } from "@/child-sign-in/api";
import { DEVICE_LABEL_MAX_LENGTH, deviceLabelSchema } from "@/child-sign-in/schema";
import { FormAlert } from "@/components/auth/form-alert";
import { MemberFailureAlert } from "@/components/members/manage/member-failure-alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import type { MemberActionError } from "@/members/manage-api";

export interface HouseholdDeviceView {
  readonly id: string;
  readonly label: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string;
  readonly lastUsedAt: string | null;
  readonly isThisDevice: boolean;
}

const formSchema = z.object({ label: deviceLabelSchema });
type FormInput = z.input<typeof formSchema>;
type FormOutput = z.output<typeof formSchema>;

/**
 * The Home's approved household devices (S42): the browsers where children of this Home may sign
 * in with a PIN. A manager approves the browser they are using now, and revokes any device; a
 * revoked device's PIN sessions end at once.
 */
export function HouseholdDevicesSetting({
  homeId,
  devices,
}: {
  readonly homeId: string;
  readonly devices: readonly HouseholdDeviceView[];
}) {
  const t = useTranslations("ChildSignIn");
  const router = useRouter();
  const hydrated = useHydrated();
  const [notice, setNotice] = useState<"approved" | "revoked" | null>(null);
  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: { label: "" },
  });
  const approve = useMutation<undefined, MemberActionError, FormOutput>({
    mutationFn: async ({ label }) => {
      await approveHouseholdDevice(homeId, { label });
      return undefined;
    },
    onSuccess: () => {
      setNotice("approved");
      form.reset({ label: "" });
      router.refresh();
    },
  });
  const revoke = useMutation<undefined, MemberActionError, string>({
    mutationFn: async (deviceId) => {
      await revokeHouseholdDevice(homeId, deviceId);
      return undefined;
    },
    onSuccess: () => {
      setNotice("revoked");
      router.refresh();
    },
  });
  const thisDeviceApproved = devices.some((device) => device.isThisDevice);
  const submit = form.handleSubmit((values) => {
    setNotice(null);
    if (!approve.isPending) approve.mutate(values);
  });

  return (
    <div className="flex flex-col gap-5" data-testid="household-devices">
      <p className="text-body text-fg-muted">{t("devicesIntro")}</p>
      {devices.length === 0 ? (
        <p className="text-body text-fg-muted">{t("devicesEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {devices.map((device) => (
            <li
              key={device.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-line p-3"
            >
              <div className="flex flex-col">
                <span className="text-body font-medium text-fg">
                  <bdi>{device.label}</bdi>
                  {device.isThisDevice ? ` (${t("thisDevice")})` : ""}
                </span>
                <span className="text-helper text-fg-muted">
                  {t("deviceApproved", {
                    time: device.approvedAt,
                    name: device.approvedBy ?? t("formerMember"),
                  })}
                  {device.lastUsedAt
                    ? ` · ${t("deviceLastUsed", { time: device.lastUsedAt })}`
                    : ""}
                </span>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!hydrated || revoke.isPending}
                aria-label={t("revokeDeviceNamed", { name: device.label })}
                onClick={() => {
                  setNotice(null);
                  revoke.mutate(device.id);
                }}
              >
                {t("revokeDevice")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <MemberFailureAlert failure={(approve.error ?? revoke.error)?.failure ?? null} />
      {notice ? (
        <FormAlert tone="success" announce>
          {notice === "approved" ? t("deviceApprovedNotice") : t("deviceRevokedNotice")}
        </FormAlert>
      ) : null}
      {thisDeviceApproved ? (
        <p className="text-body text-fg">{t("thisDeviceApproved")}</p>
      ) : (
        <form
          method="post"
          noValidate
          className="flex flex-col gap-3"
          data-testid="approve-device-form"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <TextField
            label={t("deviceLabel")}
            description={t("deviceLabelHint", { max: DEVICE_LABEL_MAX_LENGTH })}
            dir="auto"
            autoComplete="off"
            maxLength={DEVICE_LABEL_MAX_LENGTH * 2}
            error={form.formState.errors.label ? t("deviceLabelInvalid") : undefined}
            {...form.register("label")}
          />
          <div>
            <Button type="submit" disabled={!hydrated} loading={approve.isPending}>
              {t("approveThisDevice")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
