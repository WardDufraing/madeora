"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { FormAlert } from "@/components/auth/form-alert";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { useAnnouncer } from "@/components/ui/use-announcer";
import {
  CHORE_SETTINGS_ENDPOINT,
  sendChoreRequest,
  type ChoreSettings,
  type RevisionResponse,
} from "@/chores/api";
import { weekStarts } from "@/preferences/schema";
import { noMembers } from "@/tasks/format";

import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

const weekStartKey = {
  monday: "weekStart_monday",
  saturday: "weekStart_saturday",
  sunday: "weekStart_sunday",
} as const;

const formSchema = z.object({
  weekStart: z.enum(weekStarts),
  reassignmentConfirmation: z.boolean(),
});
type FormValues = z.infer<typeof formSchema>;

export interface ChoreSettingsFormProps {
  readonly homeId: string;
  readonly settings: ChoreSettings;
}

/**
 * The Home's chore settings (S21, chore managers): the day its chore weeks start (the pool's week
 * and when a chore that closes after its week closes), and whether a handover a member accepted
 * still needs a chore manager's confirmation.
 */
export function ChoreSettingsForm({ homeId, settings }: ChoreSettingsFormProps) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(noMembers);
  const { announce, region } = useAnnouncer();
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    values: {
      weekStart: settings.weekStart,
      reassignmentConfirmation: settings.reassignmentConfirmation,
    },
  });
  const mutation = useChoreMutation(
    `chore-settings:${homeId}`,
    (values: FormValues) =>
      sendChoreRequest<RevisionResponse>("PATCH", CHORE_SETTINGS_ENDPOINT, {
        homeId,
        expectedRevision: settings.revision,
        ...values,
      }),
    () => {
      announce(t("announceSaved"));
    },
  );
  return (
    <section aria-labelledby="chore-settings-heading" className="flex flex-col gap-3">
      <HydrationGate>
        {region}
        <h2 id="chore-settings-heading" className="text-section-title font-semibold text-fg">
          {t("settingsHeading")}
        </h2>
        <form
          noValidate
          onSubmit={(event) => {
            void form.handleSubmit((values) => {
              mutation.mutate(values);
            })(event);
          }}
          className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4"
          data-testid="chore-settings-form"
        >
          <SelectField
            label={t("settingsWeekStart")}
            description={t("settingsWeekStartHelp")}
            options={weekStarts.map((day) => ({ value: day, label: t(weekStartKey[day]) }))}
            {...form.register("weekStart")}
          />
          <Checkbox
            label={t("settingsConfirmation")}
            description={t("settingsConfirmationHelp")}
            {...form.register("reassignmentConfirmation")}
          />
          {mutation.error ? (
            <FormAlert tone="error" announce>
              {texts.failure(mutation.error.failure)}
            </FormAlert>
          ) : null}
          <div>
            <Button type="submit" loading={mutation.busy} data-testid="chore-settings-save">
              {t("save")}
            </Button>
          </div>
        </form>
      </HydrationGate>
    </section>
  );
}
