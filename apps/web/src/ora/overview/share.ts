import { decideHomeAction, type HomeRole } from "@madeora/domain/permissions";

import type { Overview, OverviewItem, OverviewModule } from "./types";

/**
 * The privacy filter for a copyable summary (S46; spec "copyable privacy-filtered overview
 * sharing"). Pure and deliberately conservative: an item is kept only when BOTH the requester (who
 * already sees it, because the overview was read with their session) and the chosen audience may
 * see it, and when that can be shown rather than assumed.
 *
 * - Only a Home can be shared, to another current adult member of that Home. Personal space is never
 *   shared, and a child or deactivated member is never offered: what they may see cannot be verified
 *   here, and a summary must not claim to be safe for an audience that was not checked.
 * - A module counts only when the audience's own role may view it (the permission engine, with no
 *   grants: viewing a module needs none).
 * - Calendar: only the Home's own events. Personal events shared into the Home by someone, and events
 *   synced from Google Calendar, belong to individuals and are left out.
 * - Descriptions, locations, assignees and members' names never enter the text, and the text says
 *   only generically that some information may be left out (never what, how much or when).
 */

export interface ShareAudience {
  readonly id: string;
  readonly role: HomeRole;
}

const viewAction = {
  calendar: "home.calendar.view",
  tasks: "home.tasks.view",
  chores: "home.chores.view",
} as const satisfies Record<
  OverviewModule,
  "home.calendar.view" | "home.tasks.view" | "home.chores.view"
>;

export function audienceMayView(
  homeId: string,
  audience: ShareAudience,
  module: OverviewModule,
): boolean {
  return decideHomeAction(
    homeId,
    { homeId, role: audience.role, grantedCapabilities: new Set() },
    viewAction[module],
  ).allowed;
}

/** The items both people may see, for one audience. */
export function itemsForAudience(
  overview: Overview,
  audience: ShareAudience,
): readonly OverviewItem[] {
  const homeId = overview.homeId;
  if (homeId === null) return [];
  const kept: OverviewItem[] = [];
  for (const day of overview.days) {
    for (const item of [...day.timed, ...day.untimed]) {
      if (!audienceMayView(homeId, audience, item.module)) continue;
      if (item.module === "calendar" && item.origin !== "own") continue;
      kept.push(item);
    }
  }
  return kept;
}

export interface ShareLabels {
  readonly title: (range: { from: string; to: string; scope: "day" | "week" }) => string;
  readonly context: (home: string) => string;
  readonly audience: (name: string) => string;
  readonly day: (date: string) => string;
  readonly allDay: string;
  readonly noTime: string;
  readonly done: string;
  readonly module: (module: OverviewModule) => string;
  readonly time: (item: OverviewItem) => string | null;
  readonly empty: string;
  readonly incomplete: string;
  readonly leftOut: string;
}

/** The proposed text; the member reviews and may edit it before copying. */
export function composeShareText(
  overview: Overview,
  audience: ShareAudience & { readonly name: string },
  homeName: string,
  labels: ShareLabels,
): string {
  const items = itemsForAudience(overview, audience);
  const lines: string[] = [
    labels.title(overview),
    `${labels.context(homeName)} · ${labels.audience(audience.name)}`,
  ];
  const dates = [...new Set(items.map((item) => item.day))].sort();
  if (dates.length === 0) lines.push("", labels.empty);
  for (const date of dates) {
    lines.push("", labels.day(date));
    const ofDay = items.filter((item) => item.day === date);
    const timed = ofDay
      .filter((item) => !item.allDay && item.startsAt !== null)
      .sort((a, b) => (a.startsAt ?? "").localeCompare(b.startsAt ?? ""));
    const rest = ofDay.filter((item) => !timed.includes(item));
    for (const item of timed) {
      lines.push(
        `- ${[labels.time(item), item.title].filter(Boolean).join(" ")} (${labels.module(item.module)})`,
      );
    }
    for (const item of rest) {
      const prefix = item.module === "calendar" ? labels.allDay : labels.noTime;
      const done = item.status === "done" ? ` – ${labels.done}` : "";
      lines.push(`- ${prefix}: ${item.title} (${labels.module(item.module)})${done}`);
    }
  }
  lines.push("");
  if (overview.incomplete) lines.push(labels.incomplete);
  lines.push(labels.leftOut);
  return lines.join("\n");
}
