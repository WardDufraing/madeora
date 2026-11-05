"use client";

import { useTranslations } from "next-intl";

import { FormAlert } from "@/components/auth/form-alert";
import type { CalendarFailure, CalendarRequestError } from "@/calendar/api";

const failureKey = {
  signedOut: "failureSignedOut",
  invalid: "failureInvalid",
  notFound: "failureNotFound",
  notPermitted: "failureNotPermitted",
  stale: "failureStale",
  idTaken: "failureFailed",
  limitReached: "failureLimitReached",
  invalidMember: "failureInvalidMember",
  invalidHome: "failureInvalidHome",
  invalidDates: "failureInvalidDates",
  nonexistentTime: "failureNonexistentTime",
  invalidScope: "failureInvalidScope",
  network: "failureNetwork",
  failed: "failureFailed",
} as const satisfies Record<CalendarFailure, string>;

/** What a refused or failed calendar request means, in the page's language. */
export function useCalendarFailure() {
  const t = useTranslations("Calendar");
  return (failure: CalendarFailure) => t(failureKey[failure]);
}

/** A refused or failed request, announced at once. */
export function CalendarFailureAlert({ error }: { readonly error: CalendarRequestError | null }) {
  const text = useCalendarFailure();
  return error ? (
    <FormAlert tone="error" announce>
      {text(error.failure)}
    </FormAlert>
  ) : null;
}
