"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  optionalNotificationCategories,
  type NotificationChannel,
  type OptionalNotificationCategory,
} from "@madeora/domain/notifications";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  type NotificationActionError,
  resetNotificationPreference,
  resetNotificationQuietHours,
  setNotificationPreference,
  setNotificationQuietHours,
} from "@/notifications/api";
import { timeOfDay } from "@/notifications/schema";
import type { PreferenceRow, QuietHoursRow } from "@/notifications/types";

import { NotificationFailureAlert } from "./failure-alert";

export interface SettingsScope {
  /** `null`: the account's defaults. */
  readonly id: string | null;
  readonly name: string;
  /** The zone suggested for this scope's quiet hours: the personal zone, or the Home's own. */
  readonly suggestedTimeZone: string;
}

export interface NotificationSettingsProps {
  readonly account: SettingsScope;
  readonly homes: readonly SettingsScope[];
  readonly zoneChoices: readonly string[];
  readonly emailVerified: boolean;
  readonly preferences: readonly PreferenceRow[];
  readonly quietHours: readonly QuietHoursRow[];
}

/** The words for each category a person can configure. */
const categoryText = {
  invitations: {
    title: "categoryInvitations",
    hint: "categoryInvitationsHint",
    both: "previewBoth",
    inApp: "previewInApp",
    email: "previewEmail",
    none: "previewNone",
  },
  reminders: {
    title: "categoryReminders",
    hint: "categoryRemindersHint",
    both: "previewRemindersBoth",
    inApp: "previewRemindersInApp",
    email: "previewRemindersEmail",
    none: "previewRemindersNone",
  },
  approvals: {
    title: "categoryApprovals",
    hint: "categoryApprovalsHint",
    both: "previewApprovalsBoth",
    inApp: "previewApprovalsInApp",
    email: "previewApprovalsEmail",
    none: "previewApprovalsNone",
  },
  chores: {
    title: "categoryChores",
    hint: "categoryChoresHint",
    both: "previewChoresBoth",
    inApp: "previewChoresInApp",
    email: "previewChoresEmail",
    none: "previewChoresNone",
  },
} as const satisfies Record<OptionalNotificationCategory, Record<string, string>>;

/** Runs one change, then refreshes the page so every status and preview follows. */
function useChange<Input>(run: (input: Input) => Promise<unknown>) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const mutation = useMutation<unknown, NotificationActionError, Input>({
    mutationFn: run,
    // Changes reach the server in the order the person made them.
    scope: { id: "notification-settings" },
    onMutate: () => {
      setSaved(false);
    },
    onSuccess: () => {
      setSaved(true);
      startTransition(() => {
        router.refresh();
      });
    },
    onError: (error) => {
      if (error.failure === "signedOut") router.refresh();
    },
  });
  return { mutation, saved, failure: mutation.error?.failure ?? null };
}

/**
 * Notification settings (S14; spec "global adult notification defaults with per-Home overrides"):
 * what is always on, the account's defaults, and for every Home what it inherits or overrides, with
 * quiet hours, a plain-language preview of what is effective, and a reset for each override. Only
 * the person themselves manages these; the database enforces it.
 */
export function NotificationSettings({
  account,
  homes,
  zoneChoices,
  emailVerified,
  preferences,
  quietHours,
}: NotificationSettingsProps) {
  const t = useTranslations("NotificationSettings");
  const shared = { zoneChoices, emailVerified, preferences, quietHours };
  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <p className="text-body text-fg-muted">{t("intro")}</p>
      <section aria-labelledby="essential-title" className="flex flex-col gap-2">
        <h2 id="essential-title" className="text-section-title font-semibold">
          {t("essentialTitle")}
        </h2>
        <p className="text-body text-fg">{t("essentialText")}</p>
      </section>
      <section aria-labelledby="account-title" className="flex flex-col gap-4">
        <div>
          <h2 id="account-title" className="text-section-title font-semibold">
            {t("accountTitle")}
          </h2>
          <p className="text-body text-fg-muted">{t("accountHint")}</p>
        </div>
        <ScopeSettings scope={account} {...shared} />
      </section>
      <section aria-labelledby="homes-title" className="flex flex-col gap-4">
        <div>
          <h2 id="homes-title" className="text-section-title font-semibold">
            {t("homesTitle")}
          </h2>
          <p className="text-body text-fg-muted">{t("homesHint")}</p>
        </div>
        {homes.length === 0 ? <p className="text-body text-fg">{t("noHomes")}</p> : null}
        {homes.map((home) => (
          <ScopeSettings key={home.id} scope={home} {...shared} />
        ))}
      </section>
    </div>
  );
}

interface ScopeProps {
  readonly scope: SettingsScope;
  readonly zoneChoices: readonly string[];
  readonly emailVerified: boolean;
  readonly preferences: readonly PreferenceRow[];
  readonly quietHours: readonly QuietHoursRow[];
}

/** The choices and quiet hours of one scope: the account's defaults, or one Home. */
function ScopeSettings({ scope, zoneChoices, emailVerified, preferences, quietHours }: ScopeProps) {
  const t = useTranslations("NotificationSettings");
  const headingId = useId();
  const rows = preferences.filter((row) => row.homeId === scope.id);
  const quiet = quietHours.find((row) => row.homeId === scope.id);
  const effectiveQuiet =
    quiet ?? (scope.id ? quietHours.find((row) => row.homeId === null) : undefined);
  const quietPreview =
    effectiveQuiet?.enabled === true
      ? t("previewQuietOn", {
          start: effectiveQuiet.start,
          end: effectiveQuiet.end,
          zone: effectiveQuiet.timeZone,
        })
      : t("previewQuietOff");
  const previews = optionalNotificationCategories.map((category) => {
    const text = categoryText[category];
    const inApp = rows.find((row) => row.category === category && row.channel === "in_app");
    const email = rows.find((row) => row.category === category && row.channel === "email");
    return t(
      (inApp?.enabled ?? true)
        ? email?.enabled
          ? text.both
          : text.inApp
        : email?.enabled
          ? text.email
          : text.none,
    );
  });

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      data-testid={scope.id ? "notification-scope-home" : "notification-scope-account"}
      className="flex flex-col gap-5 rounded-card border border-line bg-surface p-5"
    >
      <h3 id={headingId} className="text-body font-semibold text-fg">
        {scope.name}
      </h3>

      {optionalNotificationCategories.map((category) => (
        <CategorySettings
          key={category}
          scope={scope}
          category={category}
          emailVerified={emailVerified}
          rows={rows.filter((row) => row.category === category)}
        />
      ))}

      <QuietHoursForm
        scope={scope}
        stored={quiet ?? null}
        inherited={effectiveQuiet && !quiet ? effectiveQuiet : null}
        zoneChoices={zoneChoices}
      />

      <div className="flex flex-col gap-1 rounded-control bg-accent-subtle p-3">
        <p className="text-helper font-semibold text-fg">{t("previewTitle")}</p>
        <p className="text-body text-fg" data-testid="notification-preview">
          {previews.join(" ")} {quietPreview}
        </p>
      </div>
    </div>
  );
}

/** One category's two channels in one scope, with its status and reset. */
function CategorySettings({
  scope,
  category,
  emailVerified,
  rows,
}: {
  readonly scope: SettingsScope;
  readonly category: OptionalNotificationCategory;
  readonly emailVerified: boolean;
  readonly rows: readonly PreferenceRow[];
}) {
  const t = useTranslations("NotificationSettings");
  const hydrated = useHydrated();
  const inApp = rows.find((row) => row.channel === "in_app");
  const email = rows.find((row) => row.channel === "email");
  const overridden = rows.some((row) => row.overridden);

  const toggle = useChange<{ channel: NotificationChannel; enabled: boolean }>((input) =>
    setNotificationPreference({ homeId: scope.id, category, ...input }),
  );
  const reset = useChange<undefined>(async () => {
    for (const row of rows) {
      if (row.overridden) {
        await resetNotificationPreference({ homeId: scope.id, category, channel: row.channel });
      }
    }
  });

  // One change at a time: a quick second click would send the same value again.
  const busy = toggle.mutation.isPending || reset.mutation.isPending;
  const status = scope.id
    ? overridden
      ? t("statusOverridden")
      : t("statusInherited")
    : overridden
      ? t("statusChosen")
      : t("statusDefault");

  return (
    <fieldset className="flex flex-col gap-2" data-testid={`notification-category-${category}`}>
      <legend className="mb-1 text-body font-medium text-fg">
        {t(categoryText[category].title)}
      </legend>
      <p className="text-helper text-fg-muted">{t(categoryText[category].hint)}</p>
      <Checkbox
        label={t("channelInApp")}
        checked={inApp?.enabled ?? true}
        disabled={!hydrated || busy}
        onChange={(event) => {
          toggle.mutation.mutate({ channel: "in_app", enabled: event.target.checked });
        }}
      />
      <Checkbox
        label={t("channelEmail")}
        {...(emailVerified ? {} : { description: t("emailUnverified") })}
        checked={email?.enabled ?? false}
        disabled={!hydrated || busy || (!emailVerified && !email?.enabled)}
        onChange={(event) => {
          toggle.mutation.mutate({ channel: "email", enabled: event.target.checked });
        }}
      />
      <p className="text-helper text-fg-muted" data-testid="notification-status">
        {status}
      </p>
      {overridden ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            disabled={!hydrated}
            loading={reset.mutation.isPending}
            onClick={() => {
              if (!reset.mutation.isPending) reset.mutation.mutate(undefined);
            }}
          >
            {scope.id ? t("resetHome") : t("resetAccount")}
          </Button>
        </div>
      ) : null}
      <NotificationFailureAlert failure={toggle.failure ?? reset.failure} />
      <p role="status" className="text-helper text-success">
        {toggle.saved || reset.saved ? t("saved") : null}
      </p>
    </fieldset>
  );
}

const formSchema = z
  .object({
    enabled: z.boolean(),
    start: timeOfDay,
    end: timeOfDay,
    timeZone: z.string().min(1),
  })
  .refine((value) => value.start !== value.end, { path: ["end"], message: "window" });
type FormValues = z.infer<typeof formSchema>;

type QuietHoursFormProps = {
  readonly scope: SettingsScope;
  readonly stored: QuietHoursRow | null;
  readonly inherited: QuietHoursRow | null;
  readonly zoneChoices: readonly string[];
};

/**
 * Holds the save and reset state outside the keyed fields: a save changes the stored values, which
 * remounts the fields, and the "Saved." confirmation must survive that remount.
 */
function QuietHoursForm(props: QuietHoursFormProps) {
  const { scope } = props;
  const save = useChange<FormValues>((values) =>
    setNotificationQuietHours({ homeId: scope.id, ...values }),
  );
  const clear = useChange<undefined>(() => resetNotificationQuietHours({ homeId: scope.id }));
  return (
    <QuietHoursFields
      // Starts afresh whenever the stored values change (after a save, a reset or a refresh).
      key={JSON.stringify(props.stored ?? props.inherited ?? null)}
      {...props}
      save={save}
      clear={clear}
    />
  );
}

function QuietHoursFields({
  scope,
  stored,
  inherited,
  zoneChoices,
  save,
  clear,
}: QuietHoursFormProps & {
  readonly save: ReturnType<typeof useChange<FormValues>>;
  readonly clear: ReturnType<typeof useChange<undefined>>;
}) {
  const t = useTranslations("NotificationSettings");
  const hydrated = useHydrated();
  const source = stored ?? inherited;
  const defaults: FormValues = {
    enabled: source?.enabled ?? false,
    start: source?.start ?? "22:00",
    end: source?.end ?? "07:00",
    timeZone: source?.timeZone ?? scope.suggestedTimeZone,
  };
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: defaults });
  const zones = zoneChoices.includes(defaults.timeZone)
    ? zoneChoices
    : [...zoneChoices, defaults.timeZone].sort();
  const errors = form.formState.errors;
  const status = stored
    ? scope.id
      ? t("quietStatusOverridden")
      : t("quietStatusChosen")
    : inherited
      ? t("quietStatusInherited")
      : t("quietStatusNone");

  return (
    <form
      method="post"
      noValidate
      aria-label={`${t("quietTitle")}: ${scope.name}`}
      onSubmit={(event) => {
        void form.handleSubmit((values) => {
          save.mutation.mutate(values);
        })(event);
      }}
      className="flex flex-col gap-3"
    >
      <h4 className="text-body font-medium text-fg">{t("quietTitle")}</h4>
      <p className="text-helper text-fg-muted">{t("quietHint")}</p>
      <Checkbox label={t("quietEnabled")} {...form.register("enabled")} />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t("quietStart")}
          type="time"
          error={errors.start ? t("invalidTime") : undefined}
          {...form.register("start")}
        />
        <TextField
          label={t("quietEnd")}
          type="time"
          error={
            errors.end
              ? errors.end.message === "window"
                ? t("invalidWindow")
                : t("invalidTime")
              : undefined
          }
          {...form.register("end")}
        />
      </div>
      <SelectField
        label={t("quietZone")}
        description={t("quietZoneHint")}
        options={zones.map((zone) => ({ value: zone, label: zone }))}
        {...form.register("timeZone")}
      />
      <p className="text-helper text-fg-muted">{status}</p>
      <NotificationFailureAlert failure={save.failure ?? clear.failure} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!hydrated} loading={save.mutation.isPending}>
          {t("quietSave")}
        </Button>
        {stored ? (
          <Button
            variant="ghost"
            disabled={!hydrated}
            loading={clear.mutation.isPending}
            onClick={() => {
              if (!clear.mutation.isPending) clear.mutation.mutate(undefined);
            }}
          >
            {scope.id ? t("quietReset") : t("quietResetAccount")}
          </Button>
        ) : null}
        <p role="status" className="text-helper text-success">
          {save.saved || clear.saved ? t("saved") : null}
        </p>
      </div>
    </form>
  );
}
