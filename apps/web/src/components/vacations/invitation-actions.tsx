"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { useChoreMutation } from "@/components/chores/use-chore-mutation";
import { useChoreTexts } from "@/components/chores/use-chore-texts";
import { Button } from "@/components/ui/button";
import { useAnnouncer } from "@/components/ui/use-announcer";
import { sendChoreRequest } from "@/chores/api";
import type { DateTimeFormats } from "@/invitations/format";
import type { MemberNames } from "@/tasks/format";
import {
  VACATION_PARTICIPANTS_ENDPOINT,
  VACATION_PROPOSALS_ENDPOINT,
  type VacationMutationResult,
} from "@/vacations/api";

import { ImpactPreview } from "./impact-preview";

type Answer = { readonly action: "accept" | "decline"; readonly dryRun: boolean };

/**
 * Answering an invitation to a vacation (S22): accepting first shows what changes for the invitee's
 * chores (their rotation turns pass on), then confirms; declining needs no preview. An invitation
 * that reached its start answers expired.
 */
export function InvitationActions({
  participantId,
  revision,
  label,
  names,
  formats,
}: {
  readonly participantId: string;
  readonly revision: number;
  readonly label: string;
  readonly names: MemberNames;
  readonly formats: Pick<DateTimeFormats, "dateFormat">;
}) {
  return (
    <AnswerActions
      scope={`vacation-participant:${participantId}`}
      url={`${VACATION_PARTICIPANTS_ENDPOINT}/${participantId}`}
      extra={{ expectedRevision: revision }}
      label={label}
      names={names}
      formats={formats}
      testId="vacation-invitation"
    />
  );
}

/** Answering a date proposal for the caller's own stay (S22), the same way. */
export function ProposalAnswerActions({
  proposalId,
  label,
  names,
  formats,
}: {
  readonly proposalId: string;
  readonly label: string;
  readonly names: MemberNames;
  readonly formats: Pick<DateTimeFormats, "dateFormat">;
}) {
  return (
    <AnswerActions
      scope={`vacation-proposal:${proposalId}`}
      url={`${VACATION_PROPOSALS_ENDPOINT}/${proposalId}`}
      extra={{}}
      label={label}
      names={names}
      formats={formats}
      testId="vacation-proposal"
    />
  );
}

function AnswerActions({
  scope,
  url,
  extra,
  label,
  names,
  formats,
  testId,
}: {
  readonly scope: string;
  readonly url: string;
  readonly extra: Record<string, unknown>;
  readonly label: string;
  readonly names: MemberNames;
  readonly formats: Pick<DateTimeFormats, "dateFormat">;
  readonly testId: string;
}) {
  const t = useTranslations("Vacations");
  const texts = useChoreTexts(names);
  const [preview, setPreview] = useState<VacationMutationResult | null>(null);
  const { announce, region } = useAnnouncer();
  const mutation = useChoreMutation(
    scope,
    (answer: Answer) =>
      sendChoreRequest<VacationMutationResult>("PATCH", url, { ...extra, ...answer }),
    (result, answer) => {
      if (answer.dryRun) {
        setPreview(result);
        return;
      }
      setPreview(null);
      announce(answer.action === "accept" ? t("announceAccepted") : t("announceDeclined"));
    },
    { refresh: (_result, answer) => !answer.dryRun },
  );
  return (
    <div className="flex flex-col gap-3">
      {region}
      {preview?.impact ? (
        <ImpactPreview impact={preview.impact} names={names} formats={formats} />
      ) : null}
      {mutation.error ? (
        <FormAlert tone="error" announce>
          {texts.failure(mutation.error.failure, mutation.error.detail)}
        </FormAlert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {preview ? (
          <Button
            size="sm"
            loading={mutation.busy}
            onClick={() => {
              mutation.mutate({ action: "accept", dryRun: false });
            }}
            aria-label={t("confirmAcceptNamed", { name: label })}
            data-testid={`${testId}-confirm`}
          >
            {t("confirmAccept")}
          </Button>
        ) : (
          <Button
            size="sm"
            loading={mutation.busy}
            onClick={() => {
              mutation.mutate({ action: "accept", dryRun: true });
            }}
            aria-label={t("acceptNamed", { name: label })}
            data-testid={`${testId}-accept`}
          >
            {t("accept")}
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={mutation.busy}
          onClick={() => {
            mutation.mutate({ action: "decline", dryRun: false });
          }}
          aria-label={t("declineNamed", { name: label })}
          data-testid={`${testId}-decline`}
        >
          {t("decline")}
        </Button>
      </div>
    </div>
  );
}
