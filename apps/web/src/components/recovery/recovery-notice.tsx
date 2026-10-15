import "server-only";

import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { FormAlert } from "@/components/auth/form-alert";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { getHomeDirectory } from "@/members/directory";
import { getRecoveryStatus } from "@/recovery/server";

import { claimantStateText, isOpenForOthers } from "./recovery-state-text";
import { RecoveryOwnerCancel } from "./recovery-owner-cancel";

/**
 * Ownership recovery on the Home dashboard (S12b; spec: a visible pending state, the Owner told,
 * adult members alerted with privacy-minimized details). The Owner sees who asked and can say they
 * still have access; the person who asked sees where their request stands; other members see only
 * that a review is open, with a link to object. Reading this as the Owner stops the requests (the
 * Owner evidently has access), which the notice says.
 */
export async function RecoveryNotice({
  homeId,
  homeName,
  accepted,
}: {
  readonly homeId: string;
  readonly homeName: string;
  /** The person just accepted ownership (`?recovery=accepted`), confirmed against their role. */
  readonly accepted: boolean;
}) {
  const [status, t] = await Promise.all([getRecoveryStatus(homeId), getTranslations("Recovery")]);
  const confirmation = accepted ? (
    <FormAlert tone="success" className="mb-6">
      {t("acceptedNotice", { home: homeName })}
    </FormAlert>
  ) : null;
  if (status.status !== "ok" || status.cases.length === 0) return confirmation;
  const recoveryLink = (
    <Link href={`/homes/${homeId}/recovery`} className="font-medium text-accent-fg underline">
      {t("openRecoveryPage")}
    </Link>
  );

  const ownCase = status.cases.find((item) => item.viewer === "claimant");
  if (ownCase) {
    if (accepted && ownCase.state === "completed") return confirmation;
    const formats = await getDateTimeFormats();
    return (
      <FormAlert tone="info" className="mb-6">
        <p data-testid="recovery-claimant-notice">
          {claimantStateText(t, ownCase, homeName, formats)}
        </p>
        <p className="mt-1">{recoveryLink}</p>
      </FormAlert>
    );
  }

  const ownerCases = status.cases.filter((item) => item.viewer === "owner");
  if (ownerCases.length > 0) {
    const [directory, formats] = await Promise.all([
      getHomeDirectory(homeId),
      getDateTimeFormats(),
    ]);
    const tMembers = await getTranslations("Members");
    return (
      <section
        className="mb-6 flex flex-col gap-3 rounded-card border border-warning bg-warning-subtle p-4"
        aria-labelledby="recovery-owner-title"
        data-testid="recovery-owner-notice"
      >
        <h2 id="recovery-owner-title" className="text-body font-semibold text-fg">
          {t("ownerNoticeTitle", { home: homeName })}
        </h2>
        <ul className="flex list-disc flex-col gap-1 ps-5 text-body text-fg">
          {ownerCases.map((item) => {
            const member =
              directory.status === "ok"
                ? directory.members.find((m) => m.membershipId === item.claimantMembershipId)
                : undefined;
            const name = member ? (member.name ?? tMembers("noName")) : t("formerMember");
            return (
              <li key={item.id}>
                {t("ownerNoticeCase", {
                  name,
                  date: formatDateTime(item.createdAt, formats),
                })}
              </li>
            );
          })}
        </ul>
        <p className="text-body text-fg">{t("ownerNoticeText")}</p>
        <RecoveryOwnerCancel homeId={homeId} />
      </section>
    );
  }

  const open = status.cases.filter((item) => isOpenForOthers(item.state));
  if (open.length === 0) return confirmation;
  const objected = open.every((item) => item.objected);
  return (
    <FormAlert tone="info" className="mb-6">
      <p className="font-semibold" data-testid="recovery-member-notice">
        {t("memberNoticeTitle", { home: homeName })}
      </p>
      <p className="mt-1">{objected ? t("memberNoticeObjected") : t("memberNoticeText")}</p>
      {objected ? null : <p className="mt-1">{recoveryLink}</p>}
    </FormAlert>
  );
}
