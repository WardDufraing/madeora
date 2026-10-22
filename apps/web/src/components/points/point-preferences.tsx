"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { leaderboardPeriods, POINTS_LIMITS, type LeaderboardPeriod } from "@madeora/domain/points";
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { FormAlert } from "@/components/auth/form-alert";
import { useChoreMutation } from "@/components/chores/use-chore-mutation";
import { useChoreTexts } from "@/components/chores/use-chore-texts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { sendChoreRequest } from "@/chores/api";
import { POINT_PREFERENCES_ENDPOINT, POINT_SETTINGS_ENDPOINT } from "@/points/api";
import { noMembers } from "@/tasks/format";

const preferencesSchema = z.object({
  participates: z.boolean(),
  target: z
    .string()
    .transform((value) => value.trim())
    .refine(
      (value) => value === "" || (/^\d{1,6}$/.test(value) && Number(value) <= POINTS_LIMITS.target),
      "target",
    )
    .transform((value) => (value === "" || Number(value) === 0 ? null : Number(value))),
  targetPaused: z.boolean(),
  shareTarget: z.boolean(),
});
type PreferencesInput = z.input<typeof preferencesSchema>;
type PreferencesOutput = z.output<typeof preferencesSchema>;

/**
 * The person's own points choices in one Home (S23; spec "Confirmed leaderboard participation" and
 * "Confirmed weekly point targets"): whether they appear on the leaderboard and the shared weekly
 * overview, and a personal weekly target they may pause and choose to share. Nobody else can set
 * these for them.
 */
export function PointPreferences({
  homeId,
  participates,
  target,
  targetPaused,
  shareTarget,
}: {
  readonly homeId: string;
  readonly participates: boolean;
  readonly target: number | null;
  readonly targetPaused: boolean;
  readonly shareTarget: boolean;
}) {
  const t = useTranslations("Points");
  const texts = useChoreTexts(noMembers);
  const { announce, region } = useAnnouncer();
  const form = useForm<PreferencesInput, unknown, PreferencesOutput>({
    resolver: zodResolver(preferencesSchema),
    defaultValues: {
      participates,
      target: target === null ? "" : String(target),
      targetPaused,
      shareTarget,
    },
  });
  const mutation = useChoreMutation(
    `point-preferences:${homeId}`,
    (values: PreferencesOutput) =>
      sendChoreRequest("PUT", POINT_PREFERENCES_ENDPOINT, { homeId, ...values }),
    () => {
      announce(t("preferencesSaved"));
    },
  );
  return (
    <form
      noValidate
      onSubmit={(event) => {
        void form.handleSubmit((values) => {
          mutation.mutate(values);
        })(event);
      }}
      className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
      data-testid="point-preferences"
    >
      {region}
      <Checkbox
        label={t("fieldParticipates")}
        description={t("fieldParticipatesHelp")}
        data-testid="point-participates"
        {...form.register("participates")}
      />
      <TextField
        type="number"
        inputMode="numeric"
        min={0}
        max={POINTS_LIMITS.target}
        label={t("fieldTarget")}
        description={t("fieldTargetHelp")}
        error={form.formState.errors.target ? t("fieldTargetInvalid") : undefined}
        className="max-w-60"
        data-testid="point-target"
        {...form.register("target")}
      />
      <Checkbox
        label={t("fieldTargetPaused")}
        data-testid="point-target-paused"
        {...form.register("targetPaused")}
      />
      <Checkbox
        label={t("fieldShareTarget")}
        description={t("fieldShareTargetHelp")}
        data-testid="point-share-target"
        {...form.register("shareTarget")}
      />
      {mutation.error ? (
        <FormAlert tone="error" announce>
          {texts.failure(mutation.error.failure)}
        </FormAlert>
      ) : null}
      <div>
        <Button type="submit" loading={mutation.busy} data-testid="point-preferences-save">
          {t("save")}
        </Button>
      </div>
    </form>
  );
}

const settingsSchema = z.object({
  leaderboardEnabled: z.boolean(),
  defaultPeriod: z.enum(leaderboardPeriods),
});
type SettingsValues = z.output<typeof settingsSchema>;

/** The Home's leaderboard settings (S23; rewards managers): on or off, and the default period. */
export function LeaderboardSettings({
  homeId,
  enabled,
  defaultPeriod,
}: {
  readonly homeId: string;
  readonly enabled: boolean;
  readonly defaultPeriod: LeaderboardPeriod;
}) {
  const t = useTranslations("Points");
  const texts = useChoreTexts(noMembers);
  const { announce, region } = useAnnouncer();
  const form = useForm<SettingsValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: { leaderboardEnabled: enabled, defaultPeriod },
  });
  const mutation = useChoreMutation(
    `point-settings:${homeId}`,
    (values: SettingsValues) =>
      sendChoreRequest("PUT", POINT_SETTINGS_ENDPOINT, { homeId, ...values }),
    () => {
      announce(t("settingsSaved"));
    },
  );
  return (
    <form
      noValidate
      onSubmit={(event) => {
        void form.handleSubmit((values) => {
          mutation.mutate(values);
        })(event);
      }}
      className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
      data-testid="leaderboard-settings"
    >
      {region}
      <Checkbox
        label={t("fieldLeaderboardEnabled")}
        description={t("fieldLeaderboardEnabledHelp")}
        data-testid="leaderboard-enabled"
        {...form.register("leaderboardEnabled")}
      />
      <SelectField
        label={t("fieldDefaultPeriod")}
        options={leaderboardPeriods.map((value) => ({ value, label: t(`period_${value}`) }))}
        className="max-w-60"
        data-testid="leaderboard-default-period"
        {...form.register("defaultPeriod")}
      />
      {mutation.error ? (
        <FormAlert tone="error" announce>
          {texts.failure(mutation.error.failure)}
        </FormAlert>
      ) : null}
      <div>
        <Button type="submit" loading={mutation.busy} data-testid="leaderboard-settings-save">
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
