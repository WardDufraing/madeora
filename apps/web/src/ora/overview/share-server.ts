import "server-only";

import { isHomeRole } from "@madeora/domain/permissions";
import { getLocale, getTranslations } from "next-intl/server";

import { defaultLocale, isLocale } from "@/i18n/locales";
import { getHomeContext } from "@/homes/server";
import { getHomeDirectory } from "@/members/directory";
import { formatDate, formatTime } from "@/preferences/regional";
import { getRegionalFormats } from "@/preferences/server";

import type { OraToolContext } from "../tools/types";
import { loadOverview } from "./server";
import { composeShareText, type ShareLabels } from "./share";
import type { OverviewShare, ShareRequest } from "./types";

export type ShareLoad =
  | { readonly status: "ok"; readonly share: OverviewShare }
  /** Personal space, a Home the person is not in, or an audience that cannot be verified. */
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" };

/**
 * Prepares the copyable text for one audience (S46). Everything is read again for this request with
 * the requester's session (membership, audience, overview), so a change since the last preview
 * (a member who left, a revoked permission, a source that went stale) shows up in the new text.
 * Nothing is stored, sent or shared: the person reviews, edits and copies it themselves.
 */
export async function prepareShare(
  context: OraToolContext,
  request: ShareRequest,
): Promise<ShareLoad> {
  const home = context.home;
  if (home === null) return { status: "invalid" };

  const [homeContext, directory] = await Promise.all([
    getHomeContext(home.id),
    getHomeDirectory(home.id),
  ]);
  if (homeContext.status === "unavailable" || directory.status === "unavailable") {
    return { status: "unavailable" };
  }
  if (homeContext.status !== "ok" || directory.status !== "ok") return { status: "invalid" };

  const audience = directory.members.find((member) => member.membershipId === request.audience);
  // Someone who is the requester, deactivated or a child cannot be verified as an audience.
  if (!audience || audience.isSelf || audience.isInactive || audience.isChild) {
    return { status: "invalid" };
  }
  if (!isHomeRole(audience.role)) return { status: "invalid" };

  const loaded = await loadOverview(context, request.request);
  if (loaded.status !== "ok") return { status: "unavailable" };
  const { overview } = loaded;

  const [t, regional, requested] = await Promise.all([
    getTranslations("OraOverview"),
    getRegionalFormats(),
    getLocale(),
  ]);
  const { dateFormat, timeFormat } = regional.effective;
  const locale = isLocale(requested) ? requested : defaultLocale;
  const dayDate = (date: string) => new Date(`${date}T00:00:00Z`);
  const labels: ShareLabels = {
    title: (range) =>
      t("share.textTitle", {
        scope: range.scope,
        from: formatDate(dayDate(range.from), "UTC", dateFormat),
        to: formatDate(dayDate(range.to), "UTC", dateFormat),
      }),
    context: (name) => t("share.textContext", { home: name }),
    audience: (name) => t("share.textAudience", { name }),
    day: (date) => formatDate(dayDate(date), "UTC", dateFormat),
    allDay: t("share.textAllDay"),
    noTime: t("share.textNoTime"),
    done: t("share.textDone"),
    module: (module) => t(`modules.${module}`),
    time: (item) =>
      item.startsAt === null
        ? null
        : formatTime(new Date(item.startsAt), item.timeZone, timeFormat, locale),
    empty: t("share.textEmpty"),
    incomplete: t("share.textIncomplete"),
    leftOut: t("share.textLeftOut"),
  };
  const name = audience.name ?? t("share.textSomeone");
  const text = composeShareText(
    overview,
    { id: audience.membershipId, role: audience.role, name },
    homeContext.context.home.name,
    labels,
  );
  return {
    status: "ok",
    share: {
      audience: { id: audience.membershipId, name: audience.name },
      text,
      incomplete: overview.incomplete,
    },
  };
}
