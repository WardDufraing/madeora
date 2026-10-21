"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";

import { FormAlert } from "@/components/auth/form-alert";
import { HydrationGate } from "@/components/tasks/hydration-gate";
import { Button } from "@/components/ui/button";
import { useAnnouncer } from "@/components/ui/use-announcer";
import {
  CHORE_REASSIGNMENTS_ENDPOINT,
  sendChoreRequest,
  type ReassignmentAction,
  type ReassignmentListItem,
} from "@/chores/api";
import type { DateTimeFormats } from "@/invitations/format";
import { formatTaskDate, memberNames, type MemberOption } from "@/tasks/format";

import { useChoreMutation } from "./use-chore-mutation";
import { useChoreTexts } from "./use-chore-texts";

export interface ChoreRequestsProps {
  readonly homeId: string;
  readonly requests: readonly ReassignmentListItem[];
  readonly members: readonly MemberOption[];
  readonly formats: DateTimeFormats;
}

/**
 * The viewer's open handover requests in a Home (S21): asked of them (accept or decline), made by
 * them (cancel), and for chore managers accepted ones waiting for confirmation (confirm or refuse).
 * The database decides every answer again and may find the request no longer applies.
 */
export function ChoreRequests({ homeId, requests, members, formats }: ChoreRequestsProps) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(memberNames(members));
  const boxes = [
    { id: "incoming", title: t("requestsIncoming") },
    { id: "confirm", title: t("requestsConfirm") },
    { id: "outgoing", title: t("requestsOutgoing") },
  ] as const;
  return (
    <section
      aria-labelledby="chore-requests-heading"
      className="flex flex-col gap-3"
      data-testid="chore-requests"
    >
      <h2 id="chore-requests-heading" className="text-section-title font-semibold text-fg">
        {t("requestsHeading")}
      </h2>
      {boxes.map((box) => {
        const items = requests.filter((request) => request.box === box.id);
        if (items.length === 0) return null;
        return (
          <div key={box.id} className="flex flex-col gap-2">
            <h3 className="text-body font-semibold text-fg">{box.title}</h3>
            <ul className="flex flex-col divide-y divide-line rounded-card border border-line bg-surface">
              {items.map((request) => (
                <li
                  key={request.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-3"
                  data-testid="chore-request"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <Link
                      href={`/homes/${homeId}/chores/${request.occurrenceId}`}
                      className="text-body font-semibold text-fg underline-offset-2 hover:underline"
                    >
                      <bdi>{request.title}</bdi>
                    </Link>
                    <p className="text-helper text-fg-muted">
                      {t("requestLine", {
                        from: texts.person(request.from),
                        to: texts.person(request.to),
                        date: formatTaskDate(request.dueDate, formats),
                      })}
                      {request.status === "awaiting_manager" ? ` ${t("requestAwaiting")}` : ""}
                    </p>
                    {request.note ? (
                      <p className="break-words text-helper text-fg">
                        <span className="font-medium">{t("noteLabel")}</span> {request.note}
                      </p>
                    ) : null}
                  </div>
                  <RequestActions
                    requestId={request.id}
                    title={request.title}
                    actions={
                      box.id === "incoming"
                        ? ["accept", "decline"]
                        : box.id === "confirm"
                          ? ["confirm", "refuse"]
                          : ["cancel"]
                    }
                  />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

const actionText = {
  accept: { label: "requestAccept", aria: "requestAcceptLabel", done: "announceRequestAccepted" },
  decline: {
    label: "requestDecline",
    aria: "requestDeclineLabel",
    done: "announceRequestDeclined",
  },
  cancel: { label: "requestCancel", aria: "requestCancelLabel", done: "announceRequestCancelled" },
  confirm: {
    label: "requestConfirm",
    aria: "requestConfirmLabel",
    done: "announceRequestConfirmed",
  },
  refuse: { label: "requestRefuse", aria: "requestRefuseLabel", done: "announceRequestRefused" },
} as const satisfies Record<ReassignmentAction, { label: string; aria: string; done: string }>;

export interface RequestActionsProps {
  readonly requestId: string;
  readonly title: string;
  readonly actions: readonly ReassignmentAction[];
}

/** The answers the viewer may give to one request, each checked again by the database. */
export function RequestActions({ requestId, title, actions }: RequestActionsProps) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(memberNames([]));
  const { announce, region } = useAnnouncer();
  const mutation = useChoreMutation(
    `chore-request:${requestId}`,
    (action: ReassignmentAction) =>
      sendChoreRequest<{ outcome: string }>(
        "PATCH",
        `${CHORE_REASSIGNMENTS_ENDPOINT}/${requestId}`,
        {
          action,
        },
      ),
    (result, action) => {
      announce(
        result.outcome === "awaiting_manager"
          ? t("announceRequestAwaiting")
          : t(actionText[action].done, { title }),
      );
    },
    // Already answered or no longer applicable: the list is stale.
    { refreshOnError: (failure) => failure === "notOpen" || failure === "invalidated" },
  );
  return (
    <HydrationGate>
      {region}
      <div className="flex flex-col items-end gap-2">
        <div className="flex flex-wrap gap-2">
          {actions.map((action, index) => (
            <Button
              key={action}
              size="sm"
              variant={index === 0 && action !== "cancel" ? "primary" : "secondary"}
              loading={mutation.busy && mutation.variables === action}
              disabled={mutation.busy}
              onClick={() => {
                mutation.mutate(action);
              }}
              aria-label={t(actionText[action].aria, { title })}
              data-testid={`chore-request-${action}`}
            >
              {t(actionText[action].label)}
            </Button>
          ))}
        </div>
        {mutation.error ? (
          <FormAlert tone="error" announce>
            {texts.failure(mutation.error.failure)}
          </FormAlert>
        ) : null}
      </div>
    </HydrationGate>
  );
}
