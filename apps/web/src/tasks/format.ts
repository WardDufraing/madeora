import type { DateTimeFormats } from "@/invitations/format";
import { formatDate } from "@/preferences/regional";

import type { TaskPerson } from "./api";

/**
 * A task's start or due date in the viewer's date format. Dates are calendar dates (date-only, in
 * the context's timezone): they are formatted as such and never converted through an instant in the
 * viewer's zone, so 20 October stays 20 October everywhere.
 */
export function formatTaskDate(date: string, formats: Pick<DateTimeFormats, "dateFormat">): string {
  return formatDate(new Date(`${date}T00:00:00Z`), "UTC", formats.dateFormat);
}

/** Names of the Home's current members by membership id, and the viewer's own membership. */
export interface MemberNames {
  readonly byId: ReadonlyMap<string, string | null>;
  readonly selfId: string | null;
}

export const noMembers: MemberNames = { byId: new Map(), selfId: null };

/** Plain data for passing from a server page to client components. */
export interface MemberOption {
  readonly id: string;
  readonly name: string | null;
  readonly isSelf: boolean;
}

export function memberNames(members: readonly MemberOption[]): MemberNames {
  return {
    byId: new Map(members.map((member) => [member.id, member.name])),
    selfId: members.find((member) => member.isSelf)?.id ?? null,
  };
}

export type PersonName =
  | { readonly kind: "me" }
  | { readonly kind: "member"; readonly name: string }
  | { readonly kind: "unnamed" }
  /** Left the Home, or the account is gone: attribution stays, without a name or a link. */
  | { readonly kind: "former" };

export function personName(person: TaskPerson, names: MemberNames): PersonName {
  if (person.me || (person.member !== null && person.member === names.selfId))
    return { kind: "me" };
  if (person.member === null || !names.byId.has(person.member)) return { kind: "former" };
  const name = names.byId.get(person.member) ?? null;
  return name ? { kind: "member", name } : { kind: "unnamed" };
}

/** Typed TanStack Query keys, always scoped by account and context (architecture.md §9). */
export const taskKeys = {
  all: ["tasks"] as const,
  page: (userId: string, homeId: string | null, query: string, loadedAt: string) =>
    ["tasks", userId, homeId ?? "personal", "page", query, loadedAt] as const,
  comments: (userId: string, taskId: string, loadedAt: string) =>
    ["tasks", userId, "comments", taskId, loadedAt] as const,
};

/** Where the context's task pages live. */
export function tasksPath(homeId: string | null): string {
  return homeId ? `/homes/${homeId}/tasks` : "/tasks";
}
