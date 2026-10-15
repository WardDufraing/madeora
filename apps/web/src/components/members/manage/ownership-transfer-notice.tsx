import "server-only";

import { getTranslations } from "next-intl/server";

import { FormAlert } from "@/components/auth/form-alert";
import { formatDateTime } from "@/invitations/format";
import { getDateTimeFormats } from "@/invitations/server";
import { getHomeDirectory } from "@/members/directory";
import { getOwnershipTransfer } from "@/members/manage-server";
import type { TransferAnswer } from "@/members/manage-schema";

import { OwnershipTransferBanner } from "./ownership-transfer-banner";

/**
 * The Home's ownership transfer as this viewer may see it (S12): the pending request for the
 * member it nominates and for the Owner who sent it, or, for the sender only, how a recent one
 * ended (declined, expired, became invalid). Nothing for anyone else. Server-rendered on the Home
 * dashboard; the database decides who sees what.
 */
export async function OwnershipTransferNotice({
  homeId,
  homeName,
  done,
}: {
  readonly homeId: string;
  readonly homeName: string;
  /** What the viewer just did on the banner (`?transfer=` on the dashboard), confirmed again here. */
  readonly done?: TransferAnswer | undefined;
}) {
  const [found, t] = await Promise.all([getOwnershipTransfer(homeId), getTranslations("Manage")]);
  const confirmation = done ? (
    <FormAlert tone="success" className="mb-6">
      {
        {
          accepted: t("accepted", { home: homeName }),
          declined: t("declined"),
          cancelled: t("cancelled"),
        }[done]
      }
    </FormAlert>
  ) : null;
  if (found.status !== "ok" || !found.transfer) return confirmation;
  const { transfer } = found;
  const [tMembers, directory, formats] = await Promise.all([
    getTranslations("Members"),
    getHomeDirectory(homeId),
    getDateTimeFormats(),
  ]);
  const recipient =
    directory.status === "ok"
      ? directory.members.find((member) => member.membershipId === transfer.recipientMembershipId)
      : undefined;
  // Someone who has left is never named any more (spec: privacy-minimized history after departure).
  const recipientName = recipient ? (recipient.name ?? tMembers("noName")) : t("formerMember");

  if (transfer.state === "pending") {
    if (!transfer.isRecipient && !transfer.isSender) return confirmation;
    return (
      <OwnershipTransferBanner
        homeId={homeId}
        homeName={homeName}
        transferId={transfer.id}
        viewer={transfer.isRecipient ? "recipient" : "sender"}
        otherName={recipientName}
        expiresLabel={formatDateTime(transfer.expiresAt, formats)}
      />
    );
  }

  // The viewer's own answer replaces the outcome notice for the transfer they just ended.
  if (confirmation) return confirmation;
  if (!transfer.isSender) return null;
  const message = {
    declined: t("outcomeDeclined", { name: recipientName }),
    expired: t("outcomeExpired", { name: recipientName }),
    invalid: t("outcomeInvalid"),
    // The sender just did this themselves and saw the confirmation; and an accepted transfer is
    // visible in the roles.
    cancelled: null,
    accepted: null,
  }[transfer.state];
  if (!message) return null;
  return (
    <FormAlert tone="info" className="mb-6">
      {message}
    </FormAlert>
  );
}
