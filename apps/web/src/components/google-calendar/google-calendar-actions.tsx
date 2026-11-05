"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  GOOGLE_CALENDAR_ENDPOINT,
  GOOGLE_SYNC_ENDPOINT,
  GoogleRequestError,
  googleCalendarEndpoint,
  sendGoogleRequest,
} from "@/google-calendar/api";

/** Sends a request, then refreshes the server-rendered page so it shows the database's state. */
function useGoogleMutation<Input>(scope: string, send: (input: Input) => Promise<unknown>) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const mutation = useMutation<unknown, GoogleRequestError, Input>({
    mutationFn: async (input) => {
      try {
        return await send(input);
      } catch (error) {
        throw error instanceof GoogleRequestError ? error : new GoogleRequestError("failed");
      }
    },
    scope: { id: scope },
    onSettled: () => {
      startTransition(() => {
        router.refresh();
      });
    },
  });
  return { ...mutation, busy: mutation.isPending || refreshing };
}

function Failure({ error }: { readonly error: GoogleRequestError | null }) {
  const t = useTranslations("GoogleCalendar");
  if (!error) return null;
  const key = {
    "too-soon": "failureTooSoon",
    "authorization-expired": "failureExpired",
    unavailable: "failureUnavailable",
    "invalid-home": "failureInvalidHome",
    "too-many": "failureTooMany",
    "not-found": "failureNotFound",
    unauthenticated: "failureSignedOut",
    network: "failureNetwork",
  } as const;
  const message = error.code in key ? t(key[error.code as keyof typeof key]) : t("failureFailed");
  return (
    <FormAlert tone="error" announce>
      {message}
    </FormAlert>
  );
}

/** Sync now: queues a run (at most once a minute; the page then says "Syncing…"). */
export function SyncNowButton({ disabled }: { readonly disabled: boolean }) {
  const t = useTranslations("GoogleCalendar");
  const sync = useGoogleMutation("google-calendar", () =>
    sendGoogleRequest("POST", GOOGLE_SYNC_ENDPOINT, {}),
  );
  return (
    <div className="flex flex-col gap-2">
      <Failure error={sync.error} />
      <div>
        <Button
          type="button"
          variant="secondary"
          disabled={disabled}
          loading={sync.busy}
          onClick={() => {
            sync.mutate(undefined);
          }}
          data-testid="google-sync-now"
        >
          {t("syncNow")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Disconnect, after a confirmation that says what goes: the synced events and every choice. When Google
 * could not be reached to revoke the access, it says so and links to Google's own permissions page.
 */
export function DisconnectButton() {
  const t = useTranslations("GoogleCalendar");
  const [confirming, setConfirming] = useState(false);
  const [unrevoked, setUnrevoked] = useState(false);
  const disconnect = useGoogleMutation("google-calendar", async () => {
    const answer = await sendGoogleRequest("DELETE", GOOGLE_CALENDAR_ENDPOINT, {});
    if (answer.revoked === false) setUnrevoked(true);
    return answer;
  });
  if (unrevoked) {
    return (
      <FormAlert tone="info" announce>
        {t("disconnectedNotRevoked")}{" "}
        <a
          href="https://myaccount.google.com/permissions"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline"
        >
          {t("googlePermissionsLink")}
          <span className="sr-only"> {t("newTab")}</span>
        </a>
      </FormAlert>
    );
  }
  if (!confirming) {
    return (
      <div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setConfirming(true);
          }}
          data-testid="google-disconnect"
        >
          {t("disconnect")}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" role="group" aria-label={t("disconnect")}>
      <Failure error={disconnect.error} />
      <p className="text-body">{t("disconnectConfirmText")}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="destructive"
          loading={disconnect.busy}
          onClick={() => {
            disconnect.mutate(undefined);
          }}
          data-testid="google-disconnect-confirm"
        >
          {t("disconnectConfirm")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setConfirming(false);
          }}
        >
          {t("cancel")}
        </Button>
      </div>
    </div>
  );
}

/**
 * One Google calendar's choices: sync it, show it on the personal calendar, share it with Homes. Only
 * explicitly chosen Homes ever see it; a calendar that does not sync shows nowhere.
 */
export function CalendarChoicesForm({
  calendarId,
  name,
  sync,
  showPersonal,
  shared,
  homes,
  canSync,
}: {
  readonly calendarId: string;
  readonly name: string;
  readonly sync: boolean;
  readonly showPersonal: boolean;
  readonly shared: readonly string[];
  readonly homes: readonly { readonly id: string; readonly name: string }[];
  readonly canSync: boolean;
}) {
  const t = useTranslations("GoogleCalendar");
  const [choice, setChoice] = useState({ sync, showPersonal, homes: shared });
  const [saved, setSaved] = useState(false);
  const save = useGoogleMutation(`google-calendar:${calendarId}`, async (input: typeof choice) => {
    await sendGoogleRequest("PUT", googleCalendarEndpoint(calendarId), input);
    setSaved(true);
  });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(false);
        save.mutate(choice.sync ? choice : { sync: false, showPersonal: false, homes: [] });
      }}
      aria-label={t("choicesFor", { name })}
      data-testid="google-calendar-form"
    >
      <Failure error={save.error} />
      {saved && !save.isPending ? (
        <FormAlert tone="success" announce>
          {t("saved")}
        </FormAlert>
      ) : null}
      <Checkbox
        label={t("syncThis")}
        checked={choice.sync}
        disabled={!canSync && !choice.sync}
        onChange={(event) => {
          const checked = event.target.checked;
          setChoice((current) => ({ ...current, sync: checked }));
        }}
        data-testid="google-calendar-sync"
      />
      <Checkbox
        label={t("showPersonal")}
        checked={choice.sync && choice.showPersonal}
        disabled={!choice.sync}
        onChange={(event) => {
          const checked = event.target.checked;
          setChoice((current) => ({ ...current, showPersonal: checked }));
        }}
        data-testid="google-calendar-personal"
      />
      {homes.length > 0 ? (
        <fieldset className="flex flex-col gap-2" disabled={!choice.sync}>
          <legend className="mb-1 text-body font-medium text-fg">{t("shareWith")}</legend>
          {homes.map((home) => (
            <Checkbox
              key={home.id}
              label={home.name}
              checked={choice.sync && choice.homes.includes(home.id)}
              onChange={(event) => {
                const checked = event.target.checked;
                setChoice((current) => ({
                  ...current,
                  homes: checked
                    ? [...current.homes, home.id]
                    : current.homes.filter((id) => id !== home.id),
                }));
              }}
              data-testid="google-calendar-home"
            />
          ))}
          <p className="text-helper text-fg-muted">{t("shareHint")}</p>
        </fieldset>
      ) : null}
      <div>
        <Button type="submit" loading={save.busy} data-testid="google-calendar-save">
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
