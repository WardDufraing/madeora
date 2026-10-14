"use client";

import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { FormAlert } from "@/components/auth/form-alert";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Button } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  requestToJoin,
  type InvitationActionError,
  type JoinRequestResponse,
} from "@/invitations/api";
import { formatDateTime, isolate, type DateTimeFormats } from "@/invitations/format";
import type { InvitationPreview } from "@/invitations/types";

import { InvitationFailureAlert } from "./failure-alert";
import { useInvitationLabels } from "./use-labels";

const REQUESTS_PATH = "/homes/join";

/**
 * The `/join/{token}` page body (S10): what the link or code offers (Home, role, expiry) and the
 * button that asks to join, or why it cannot be used. Asking creates a pending request; a manager
 * approves it before the person becomes a member. When the server answers with another state
 * (the invitation ended meanwhile), the page is read again so it shows that state.
 */
export function JoinInvitation({
  token,
  preview,
  formats,
}: {
  readonly token: string;
  readonly preview: InvitationPreview;
  readonly formats: DateTimeFormats;
}) {
  const t = useTranslations("Invitations");
  const labels = useInvitationLabels();
  const router = useRouter();
  const hydrated = useHydrated();
  const [requested, setRequested] = useState<string | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  const mutation = useMutation<JoinRequestResponse, InvitationActionError, string>({
    mutationFn: requestToJoin,
    onSuccess: ({ outcome }) => {
      if (outcome === "requested" && preview.outcome === "ok") setRequested(preview.homeName);
      else router.refresh();
    },
    onError: (error) => {
      if (error.failure === "signedOut") router.refresh();
    },
  });

  useEffect(() => {
    if (requested) resultHeading.current?.focus();
  }, [requested]);

  if (requested) {
    return (
      <section aria-labelledby="join-result" className="flex max-w-xl flex-col gap-3">
        <h2
          id="join-result"
          ref={resultHeading}
          tabIndex={-1}
          className="text-section-title font-semibold text-fg"
        >
          {t("requestSentTitle")}
        </h2>
        <p className="text-body text-fg">
          {t("requestSentDescription", { home: isolate(requested) })}
        </p>
        <Link href={REQUESTS_PATH} className="text-body font-medium text-accent-fg underline">
          {t("viewMyRequests")}
        </Link>
      </section>
    );
  }

  if (preview.outcome !== "ok") return <JoinOutcomeMessage preview={preview} />;

  return (
    <section aria-labelledby="join-offer" className="flex max-w-xl flex-col gap-4">
      <h2 id="join-offer" className="text-section-title font-semibold text-fg">
        {t(preview.kind === "join_code" ? "askToJoinHeading" : "invitedHeading", {
          home: isolate(preview.homeName),
        })}
      </h2>
      <dl className="grid gap-x-6 gap-y-2 text-body sm:grid-cols-[max-content_1fr]">
        <dt className="font-medium text-fg">{t("roleTerm")}</dt>
        <dd className="text-fg" data-testid="join-role">
          {labels.role(preview.role)}
        </dd>
        <dt className="font-medium text-fg">{t("expiresTerm")}</dt>
        <dd className="text-fg">{formatDateTime(preview.expiresAt, formats)}</dd>
      </dl>
      <p className="text-body text-fg-muted">{t("approvalNote")}</p>
      <InvitationFailureAlert failure={mutation.error?.failure ?? null} />
      <div>
        <Button
          type="button"
          disabled={!hydrated}
          loading={mutation.isPending}
          onClick={() => {
            if (!mutation.isPending) mutation.mutate(token);
          }}
        >
          {preview.kind === "join_code" ? t("askToJoin") : t("acceptInvitation")}
        </Button>
      </div>
    </section>
  );
}

const outcomeKeys = {
  invalid: { title: "outcomeInvalidTitle", description: "outcomeInvalid" },
  expired: { title: "outcomeExpiredTitle", description: "outcomeExpired" },
  revoked: { title: "outcomeRevokedTitle", description: "outcomeRevoked" },
  used_up: { title: "outcomeUsedUpTitle", description: "outcomeUsedUp" },
  email_mismatch: { title: "outcomeEmailMismatchTitle", description: "outcomeEmailMismatch" },
  declined: { title: "outcomeDeclinedTitle", description: "outcomeDeclined" },
  rate_limited: { title: "outcomeRateLimitedTitle", description: "outcomeRateLimited" },
} as const;

/** Why a link or code cannot be used now, with the way forward where there is one. */
export function JoinOutcomeMessage({
  preview,
}: {
  readonly preview: Exclude<InvitationPreview, { readonly outcome: "ok" }>;
}) {
  const t = useTranslations("Invitations");

  if (preview.outcome === "already_member") {
    return (
      <div className="flex max-w-xl flex-col gap-3" data-testid="join-outcome">
        <h2 className="text-section-title font-semibold text-fg">{t("outcomeMemberTitle")}</h2>
        <p className="text-body text-fg">
          {t("outcomeMember", { home: isolate(preview.homeName) })}
        </p>
        <Link
          href={`/homes/${preview.homeId}`}
          className="text-body font-medium text-accent-fg underline"
        >
          {t("openHome")}
        </Link>
      </div>
    );
  }

  if (preview.outcome === "pending") {
    return (
      <div className="flex max-w-xl flex-col gap-3" data-testid="join-outcome">
        <h2 className="text-section-title font-semibold text-fg">{t("outcomePendingTitle")}</h2>
        <p className="text-body text-fg">
          {t("outcomePending", { home: isolate(preview.homeName) })}
        </p>
        <Link href={REQUESTS_PATH} className="text-body font-medium text-accent-fg underline">
          {t("viewMyRequests")}
        </Link>
      </div>
    );
  }

  const keys = outcomeKeys[preview.outcome];
  return (
    <div className="flex max-w-xl flex-col gap-3" data-testid="join-outcome">
      <h2 className="text-section-title font-semibold text-fg">{t(keys.title)}</h2>
      <FormAlert tone="info">{t(keys.description)}</FormAlert>
      {preview.outcome === "email_mismatch" ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-body text-fg-muted">{t("emailMismatchSwitch")}</p>
          <SignOutButton />
        </div>
      ) : null}
      <Link href={REQUESTS_PATH} className="text-body font-medium text-accent-fg underline">
        {t("enterCodeInstead")}
      </Link>
    </div>
  );
}
