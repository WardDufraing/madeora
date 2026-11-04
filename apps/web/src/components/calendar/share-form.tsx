"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { eventEndpoint, sendCalendarRequest } from "@/calendar/api";
import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

import { CalendarFailureAlert } from "./calendar-failure";
import { useCalendarMutation } from "./use-calendar-mutation";

/**
 * Which of the person's Homes see a personal event (S32; owner only). Members there see it in full
 * and read-only, marked "Shared by"; nobody else gets edit rights. Unsharing hides it there on the
 * next request.
 */
export function ShareForm({
  eventId,
  revision,
  homes,
  shared,
}: {
  readonly eventId: string;
  readonly revision: number;
  readonly homes: readonly { readonly id: string; readonly name: string }[];
  readonly shared: readonly string[];
}) {
  const t = useTranslations("Calendar");
  const [chosen, setChosen] = useState<readonly string[]>(shared);
  const [saved, setSaved] = useState(false);
  const save = useCalendarMutation(
    `calendar-event:${eventId}`,
    (homeIds: readonly string[]) =>
      sendCalendarRequest("PUT", eventEndpoint(eventId, "shares"), { revision, homeIds }),
    () => {
      setSaved(true);
    },
  );
  if (homes.length === 0) {
    return <p className="text-body text-fg-muted">{t("shareNoHomes")}</p>;
  }
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(false);
        save.mutate(chosen);
      }}
      data-testid="event-share-form"
    >
      <CalendarFailureAlert error={save.error} />
      {saved && !save.isPending ? (
        <FormAlert tone="success" announce>
          {t("shareSaved")}
        </FormAlert>
      ) : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-body font-medium text-fg">{t("fieldShares")}</legend>
        {homes.map((home) => (
          <Checkbox
            key={home.id}
            label={home.name}
            checked={chosen.includes(home.id)}
            onChange={(event) => {
              const checked = event.target.checked;
              setChosen((current) =>
                checked ? [...current, home.id] : current.filter((id) => id !== home.id),
              );
            }}
            data-testid="event-share-home"
          />
        ))}
      </fieldset>
      <div>
        <Button type="submit" loading={save.busy} data-testid="event-share-save">
          {t("shareSave")}
        </Button>
      </div>
    </form>
  );
}
