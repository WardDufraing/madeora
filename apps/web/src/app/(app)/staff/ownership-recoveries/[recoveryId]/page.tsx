import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { requireIdentity } from "@/auth/identity";
import { FormAlert } from "@/components/auth/form-alert";
import { StaffCloseAppealForm } from "@/components/recovery/staff-close-appeal-form";
import { StaffDecisionForm } from "@/components/recovery/staff-decision-form";
import { staffActionsFor, staffStateKey } from "@/components/recovery/staff-state-label";
import { PageHeader } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { pageTitle } from "@/i18n/page-title";
import { formatDateTime, type DateTimeFormats } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { getStaffCase } from "@/recovery/server";

interface StaffCasePageProps {
  readonly params: Promise<{ readonly recoveryId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Recovery");
  return { title: await pageTitle(t("staffCaseTitle")) };
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
      <dt className="text-helper text-fg-muted sm:w-48 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 text-body text-fg">{children}</dd>
    </div>
  );
}

function when(value: string | null, formats: DateTimeFormats, none: string): string {
  return value ? formatDateTime(value, formats) : none;
}

/**
 * One recovery case for Madeora staff (S12b; architecture.md §43): the statement, who asked and
 * the Owner's verified contact details, objections and appeals, and the decision form. Staff verify
 * identity and authority outside Madeora (for example a video call with ID) before approving; the
 * page says so. Reading the case is audited by the database.
 */
export default async function StaffCasePage({ params }: StaffCasePageProps) {
  await requireIdentity();
  const { recoveryId } = await params;
  const [read, t, tHomes, formats] = await Promise.all([
    getStaffCase(recoveryId),
    getTranslations("Recovery"),
    getTranslations("Homes"),
    getDateTimeFormats(),
  ]);
  const roleName = {
    owner: tHomes("roleOwner"),
    administrator: tHomes("roleAdministrator"),
    member: tHomes("roleMember"),
  } as const;
  if (read.status === "not-staff") notFound();
  const back = (
    <p className="mb-6 text-body">
      <Link href="/staff/ownership-recoveries" className="font-medium text-accent-fg underline">
        {t("staffBackToQueue")}
      </Link>
    </p>
  );
  if (read.status === "unavailable") {
    return (
      <>
        <PageHeader title={t("staffCaseTitle")} />
        {back}
        <FormAlert tone="error">{t("loadFailed")}</FormAlert>
      </>
    );
  }
  const recovery = read.value;
  if (!recovery) notFound();
  const none = t("staffNone");
  const actions = staffActionsFor(recovery.state);

  return (
    <>
      <PageHeader title={t("staffCaseTitle")} />
      {back}
      <div className="flex max-w-3xl flex-col gap-6">
        <Card title={recovery.homeName}>
          <dl className="flex flex-col gap-2">
            <Row label={t("staffState")}>
              <span data-testid="staff-case-state">{t(staffStateKey[recovery.state])}</span>
            </Row>
            <Row label={t("staffSubmitted")}>{when(recovery.createdAt, formats, none)}</Row>
            <Row label={t("staffReviewStarted")}>
              {when(recovery.reviewStartedAt, formats, none)}
            </Row>
            <Row label={t("staffApproved")}>{when(recovery.approvedAt, formats, none)}</Row>
            <Row label={t("staffObjectionEnds")}>
              {when(recovery.objectionEndsAt, formats, none)}
            </Row>
            <Row label={t("staffDecidedAt")}>{when(recovery.decidedAt, formats, none)}</Row>
            <Row label={t("staffMemberCount")}>{recovery.memberCount}</Row>
            {recovery.formerOwnerOutcome ? (
              <Row label={t("staffOutcomeLegend")}>
                {recovery.formerOwnerOutcome === "removed"
                  ? t("staffOutcomeRemoved")
                  : t("staffOutcomeMember")}
              </Row>
            ) : null}
          </dl>
        </Card>

        <Card title={t("staffClaimantTitle")}>
          <dl className="flex flex-col gap-2">
            <Row label={t("staffName")}>
              {recovery.claimantName ? <bdi>{recovery.claimantName}</bdi> : none}
            </Row>
            <Row label={t("staffEmail")}>{recovery.claimantEmail ?? none}</Row>
            <Row label={t("staffRole")}>
              {recovery.claimantRole ? roleName[recovery.claimantRole] : t("staffLeft")}
            </Row>
            <Row label={t("staffMemberSince")}>
              {when(recovery.claimantMemberSince, formats, none)}
            </Row>
          </dl>
          <h3 className="mt-4 mb-1 text-body font-semibold text-fg">{t("staffStatement")}</h3>
          <p className="whitespace-pre-wrap text-body text-fg" data-testid="staff-statement">
            {recovery.statement}
          </p>
        </Card>

        <Card title={t("staffOwnerTitle")} description={t("staffOwnerHint")}>
          <dl className="flex flex-col gap-2">
            <Row label={t("staffEmail")}>{recovery.ownerEmail ?? none}</Row>
            <Row label={t("staffLanguage")}>{recovery.ownerLocale ?? none}</Row>
            <Row label={t("staffLastSignIn")}>
              {when(recovery.ownerLastSignInAt, formats, none)}
            </Row>
            <Row label={t("staffOwnerSeen")}>{when(recovery.ownerSeenAt, formats, none)}</Row>
            <Row label={t("staffStillOwner")}>
              {recovery.ownerIsOwner ? t("staffYes") : t("staffNo")}
            </Row>
          </dl>
        </Card>

        <Card title={t("staffObjectionsTitle")}>
          {recovery.objections.length === 0 ? (
            <p className="text-body text-fg-muted">{t("staffNoObjections")}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {recovery.objections.map((objection, index) => (
                <li key={index} className="flex flex-col gap-1">
                  <span className="text-helper text-fg-muted">
                    {roleName[objection.role]}
                    {" \u{00B7} "}
                    {formatDateTime(objection.createdAt, formats)}
                  </span>
                  <p className="whitespace-pre-wrap text-body text-fg">{objection.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {recovery.appeals.length > 0 ? (
          <Card title={t("staffAppealsTitle")}>
            <ul className="flex flex-col gap-4">
              {recovery.appeals.map((appeal) => (
                <li key={appeal.id} className="flex flex-col gap-2">
                  <span className="text-helper text-fg-muted">
                    {formatDateTime(appeal.createdAt, formats)}
                    {" \u{00B7} "}
                    {appeal.status === "open" ? t("staffAppealOpen") : t("staffAppealClosed")}
                  </span>
                  <p className="whitespace-pre-wrap text-body text-fg">{appeal.reason}</p>
                  {appeal.staffNotes ? (
                    <p className="whitespace-pre-wrap text-body text-fg-muted">
                      {appeal.staffNotes}
                    </p>
                  ) : null}
                  {appeal.status === "open" ? <StaffCloseAppealForm appealId={appeal.id} /> : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {recovery.staffNotes ? (
          <Card title={t("staffNotesTitle")}>
            <p className="whitespace-pre-wrap text-body text-fg" data-testid="staff-notes">
              {recovery.staffNotes}
            </p>
          </Card>
        ) : null}

        {actions.length > 0 ? (
          <Card title={t("staffDecisionTitle")} description={t("staffDecisionHint")}>
            <StaffDecisionForm recoveryId={recovery.id} actions={actions} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
