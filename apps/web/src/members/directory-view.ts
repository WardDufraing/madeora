import { homeRoles, type HomeRole } from "@madeora/domain/permissions";

import type { AccentColor } from "@/accent/accent";

/**
 * The member directory's view logic (S11; spec "Confirmed simple Home member directory without
 * custom groups"): sorting, role filters and duplicate-name detection. Pure and client-safe; the
 * page applies it to what `home_directory` returned. The view choices come from the URL, so they
 * are this viewer's own and never change anyone else's directory.
 */

/** One current member as every member of the Home may see them. */
export interface DirectoryMember {
  /** The stable Home-member id; attribution never depends on names or colours. */
  readonly membershipId: string;
  readonly role: HomeRole;
  /** When they joined this Home (ISO instant). */
  readonly joinedAt: string;
  readonly isSelf: boolean;
  /** The effective Home name, or `null` when the person has none. */
  readonly name: string | null;
  /** The effective identifying colour, or `null` for the default accent. */
  readonly accentColor: AccentColor | null;
}

export const directorySorts = ["role", "name", "joined"] as const;
export type DirectorySort = (typeof directorySorts)[number];

export interface DirectoryQuery {
  readonly sort: DirectorySort;
  /** The roles to show; empty shows everyone. */
  readonly roles: ReadonlySet<HomeRole>;
}

export const defaultDirectoryQuery: DirectoryQuery = { sort: "role", roles: new Set() };

type SearchParamValue = string | readonly string[] | undefined;

function values(value: SearchParamValue): readonly string[] {
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : value;
}

/** `?sort=` and any number of `?role=` from the URL; anything unknown is ignored. */
export function parseDirectoryQuery(params: {
  readonly sort?: SearchParamValue;
  readonly role?: SearchParamValue;
}): DirectoryQuery {
  const sort = values(params.sort).find((value): value is DirectorySort =>
    (directorySorts as readonly string[]).includes(value),
  );
  const roles = new Set(
    values(params.role).filter((value): value is HomeRole =>
      (homeRoles as readonly string[]).includes(value),
    ),
  );
  // Every role selected is the same as none: show everyone, and say no filter is active.
  return { sort: sort ?? "role", roles: roles.size === homeRoles.length ? new Set() : roles };
}

/** Whether the view differs from the default (so "Reset" has something to do). */
export function isCustomized(query: DirectoryQuery): boolean {
  return query.sort !== "role" || query.roles.size > 0;
}

const roleRank: { readonly [R in HomeRole]: number } = { owner: 0, administrator: 1, member: 2 };

/**
 * The members to show, filtered and in order. Role order is Owner, Administrators, Members, then
 * by name; name order is alphabetical; joined order is oldest first. People without a name come
 * after named people, and the stable membership id breaks every remaining tie.
 */
export function arrangeDirectory(
  members: readonly DirectoryMember[],
  query: DirectoryQuery,
  collator: Intl.Collator,
): DirectoryMember[] {
  const byName = (a: DirectoryMember, b: DirectoryMember) => {
    if (a.name === null || b.name === null) {
      return a.name === b.name ? 0 : a.name === null ? 1 : -1;
    }
    return collator.compare(a.name, b.name);
  };
  const byRole = (a: DirectoryMember, b: DirectoryMember) => roleRank[a.role] - roleRank[b.role];
  const byJoined = (a: DirectoryMember, b: DirectoryMember) =>
    Date.parse(a.joinedAt) - Date.parse(b.joinedAt);
  const byId = (a: DirectoryMember, b: DirectoryMember) =>
    a.membershipId.localeCompare(b.membershipId);

  const order = {
    role: [byRole, byName, byJoined, byId],
    name: [byName, byRole, byJoined, byId],
    joined: [byJoined, byName, byId],
  }[query.sort];

  return members
    .filter((member) => query.roles.size === 0 || query.roles.has(member.role))
    .sort((a, b) => {
      for (const compare of order) {
        const result = compare(a, b);
        if (result !== 0) return result;
      }
      return 0;
    });
}

/**
 * The members whose visible name another member shares (spec: duplicate names are allowed, so
 * they need an extra, privacy-safe qualifier; never colour alone). Names that differ only in case
 * or accents count as the same, as do people without a name. Checked over the whole Home, not
 * just the filtered list, so a qualifier does not come and go with filters.
 */
export function sharedNameIds(
  members: readonly DirectoryMember[],
  collator: Intl.Collator,
): ReadonlySet<string> {
  const shared = new Set<string>();
  for (const [index, member] of members.entries()) {
    for (const other of members.slice(index + 1)) {
      const same =
        member.name === null || other.name === null
          ? member.name === other.name
          : collator.compare(member.name, other.name) === 0;
      if (same) {
        shared.add(member.membershipId);
        shared.add(other.membershipId);
      }
    }
  }
  return shared;
}

/** A collator that treats names alike when they differ only in case or accents. */
export function nameCollator(locale: string): Intl.Collator {
  return new Intl.Collator(locale, { sensitivity: "base", numeric: true, usage: "sort" });
}
