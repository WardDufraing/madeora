import { homeRoles, type HomeRole } from "@madeora/domain/permissions";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/states";
import { formatDateTime, type DateTimeFormats } from "@/invitations/format";
import {
  directorySorts,
  isCustomized,
  type DirectoryMember,
  type DirectoryQuery,
} from "@/members/directory-view";
import { formatDate } from "@/preferences/regional";

import { MemberAvatar } from "./member-avatar";

export interface MemberDirectoryProps {
  readonly homeId: string;
  /** The members to show, already filtered and ordered. */
  readonly shown: readonly DirectoryMember[];
  /** Every current member, so qualifiers do not change with filters. */
  readonly all: readonly DirectoryMember[];
  /** How many current members the Home has in all. */
  readonly total: number;
  readonly query: DirectoryQuery;
  /** Members whose visible name another member shares; they get a "joined" qualifier. */
  readonly sharedNames: ReadonlySet<string>;
  /** Members the viewer may act on (S12): their row links to their page. */
  readonly manageable: ReadonlySet<string>;
  readonly formats: DateTimeFormats;
}

const roleKey = {
  owner: "roleOwner",
  administrator: "roleAdministrator",
  member: "roleMember",
} as const satisfies Record<HomeRole, string>;

const sortKey = {
  role: "sortRole",
  name: "sortName",
  joined: "sortJoined",
} as const;

/**
 * The member directory (S11; spec "Confirmed simple Home member directory without custom
 * groups"): one list of the Home's current members with their avatar, effective Home name, role
 * and, when names are shared, the date they joined, so nobody is told apart by colour alone. The
 * view controls are a plain GET form: they work without JavaScript, live in the URL and change
 * only this viewer's view. Server-rendered. A member the viewer may manage (S12: change their role
 * or rights, ask them to become Owner, remove them) gets a Manage link to their page.
 */
export async function MemberDirectory({
  homeId,
  shown,
  all,
  total,
  query,
  sharedNames,
  manageable,
  formats,
}: MemberDirectoryProps) {
  const [t, tHomes, tManage] = await Promise.all([
    getTranslations("Members"),
    getTranslations("Homes"),
    getTranslations("Manage"),
  ]);
  const filtered = query.roles.size > 0;

  // A qualifier for each member who shares a name: the joining date, with the time as well when
  // two of them joined on the same day.
  const day = (member: DirectoryMember) =>
    formatDate(new Date(member.joinedAt), formats.timeZone, formats.dateFormat);
  const sharedDays = new Map<string, number>();
  for (const member of all) {
    if (sharedNames.has(member.membershipId)) {
      sharedDays.set(day(member), (sharedDays.get(day(member)) ?? 0) + 1);
    }
  }
  const qualifier = (member: DirectoryMember) =>
    (sharedDays.get(day(member)) ?? 0) > 1 ? formatDateTime(member.joinedAt, formats) : day(member);

  return (
    <div className="flex flex-col gap-6">
      <form
        method="get"
        action={`/homes/${homeId}/members`}
        className="flex flex-wrap items-end gap-x-6 gap-y-4"
        aria-label={t("viewControls")}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="directory-sort" className="text-body font-medium text-fg">
            {t("sortLabel")}
          </label>
          <select
            id="directory-sort"
            name="sort"
            defaultValue={query.sort}
            className="min-h-10 rounded-control border border-line-control bg-surface px-3 text-body text-fg"
          >
            {directorySorts.map((sort) => (
              <option key={sort} value={sort}>
                {t(sortKey[sort])}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-body font-medium text-fg">{t("filterLegend")}</legend>
          <div className="flex flex-wrap gap-x-4">
            {homeRoles.map((role) => (
              <label
                key={role}
                className="flex min-h-10 cursor-pointer items-center gap-2 text-body"
              >
                <input
                  type="checkbox"
                  name="role"
                  value={role}
                  defaultChecked={query.roles.has(role)}
                  className="size-5 cursor-pointer accent-accent"
                />
                {tHomes(roleKey[role])}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-4">
          <button
            type="submit"
            className="min-h-10 rounded-control bg-accent px-4 text-body font-medium text-on-accent hover:bg-accent-hover active:bg-accent-pressed"
          >
            {t("apply")}
          </button>
          {isCustomized(query) ? (
            <Link
              href={`/homes/${homeId}/members`}
              className="text-body font-medium text-accent-fg underline"
            >
              {t("reset")}
            </Link>
          ) : null}
        </div>
      </form>

      <Card>
        <p className="mb-2 text-helper text-fg-muted" data-testid="member-count">
          {filtered ? t("countFiltered", { shown: shown.length, total }) : t("count", { total })}
        </p>
        {shown.length === 0 ? (
          <EmptyState
            title={t("noMatchTitle")}
            description={t("noMatchDescription")}
            action={
              <Link
                href={`/homes/${homeId}/members`}
                className="text-body font-medium text-accent-fg underline"
              >
                {t("reset")}
              </Link>
            }
          />
        ) : (
          <ul aria-label={t("listLabel")} className="divide-y divide-line">
            {shown.map((member) => (
              <li
                key={member.membershipId}
                className="flex items-center gap-3 py-3"
                data-testid="directory-member"
              >
                <MemberAvatar
                  name={member.name}
                  accentColor={member.accentColor}
                  locale={formats.locale}
                  avatarFileId={member.avatarFileId ?? null}
                />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-body font-semibold text-fg" data-testid="member-name">
                    {member.name === null ? t("noName") : <bdi>{member.name}</bdi>}
                    {member.isSelf ? (
                      <span className="font-normal text-fg-muted"> {t("you")}</span>
                    ) : null}
                  </span>
                  <span className="text-helper text-fg-muted">
                    {tHomes(roleKey[member.role])}
                    {sharedNames.has(member.membershipId) ? (
                      <span data-testid="member-qualifier">
                        {" \u{00B7} "}
                        {t("joined", { date: qualifier(member) })}
                      </span>
                    ) : null}
                  </span>
                </div>
                {member.isSelf ? (
                  <Link
                    href={`/homes/${homeId}/profile`}
                    className="shrink-0 text-body font-medium text-accent-fg underline"
                  >
                    {t("editYours")}
                  </Link>
                ) : manageable.has(member.membershipId) ? (
                  <Link
                    href={`/homes/${homeId}/members/${member.membershipId}`}
                    className="shrink-0 text-body font-medium text-accent-fg underline"
                    data-testid="manage-member-link"
                    aria-label={tManage("manageLinkLabel", { name: member.name ?? t("noName") })}
                  >
                    {tManage("manageLink")}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
