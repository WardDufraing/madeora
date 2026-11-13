import type { HomeAction } from "@madeora/domain/permissions";

import type { OraToolId } from "./ids";
import type { OraToolContext, OraToolDefinition, OraToolGroup, OraToolSummary } from "./types";

interface Destination {
  /** Also the label key in the `Ora.tools` dictionary. */
  readonly id: OraToolId;
  readonly group: OraToolGroup;
  readonly quick: boolean;
  /** The page inside a Home (`""` is the Home's dashboard) and the action that allows it. */
  readonly home?: { readonly path: string; readonly action: HomeAction };
  /** The Personal-space page, when there is one. */
  readonly personal?: string;
}

/** Everyday destinations: in a Home each needs that module's view permission. */
const destinations: readonly Destination[] = [
  {
    id: "open-dashboard",
    group: "overview",
    quick: false,
    home: { path: "", action: "home.dashboard.view" },
    personal: "/?context=personal",
  },
  {
    id: "open-tasks",
    group: "tasks",
    quick: true,
    home: { path: "tasks", action: "home.tasks.view" },
    personal: "/tasks",
  },
  {
    id: "open-chores",
    group: "chores",
    quick: true,
    home: { path: "chores", action: "home.chores.view" },
  },
  {
    id: "open-meals",
    group: "meals",
    quick: false,
    home: { path: "meals", action: "home.meals.view" },
  },
  {
    id: "open-shopping",
    group: "shopping",
    quick: true,
    home: { path: "shopping", action: "home.shopping.view" },
  },
  {
    id: "open-habits",
    group: "habits",
    quick: false,
    home: { path: "habits", action: "home.habits.view" },
    personal: "/habits",
  },
  {
    id: "open-goals",
    group: "goals",
    quick: false,
    home: { path: "goals", action: "home.goals.view" },
    personal: "/goals",
  },
  {
    id: "open-pets",
    group: "pets",
    quick: false,
    home: { path: "pets", action: "home.pets.view" },
  },
  {
    id: "open-calendar",
    group: "calendar",
    quick: true,
    home: { path: "calendar", action: "home.calendar.view" },
    personal: "/calendar",
  },
  {
    id: "open-photos",
    group: "photos",
    quick: false,
    home: { path: "photos", action: "home.photos.view" },
    personal: "/photos",
  },
  // Home management: these are the destinations whose permission differs by role, so a Member
  // never sees them while an Owner (or an Administrator holding the grant) does.
  {
    id: "open-members",
    group: "home",
    quick: false,
    home: { path: "members", action: "home.members.view" },
  },
  {
    id: "open-invitations",
    group: "home",
    quick: false,
    home: { path: "invitations", action: "home.invitations.manage" },
  },
  {
    id: "open-displays",
    group: "home",
    quick: false,
    home: { path: "displays", action: "home.updateSettings" },
  },
  {
    id: "open-home-settings",
    group: "home",
    quick: false,
    home: { path: "settings", action: "home.updateSettings" },
  },
];

function homeHref(context: OraToolContext, path: string): string {
  // Never reached without a Home (the registry checks the place first); the root names no Home.
  const id = context.home?.id;
  if (id === undefined) return "/";
  return path === "" ? `/homes/${id}` : `/homes/${id}/${path}`;
}

function toDefinitions(destination: Destination): OraToolDefinition[] {
  const { id, group, quick } = destination;
  const definitions: OraToolDefinition[] = [];
  if (destination.home) {
    const { path, action } = destination.home;
    definitions.push({
      id,
      kind: "navigate",
      group,
      quick,
      requires: { scope: "home", action },
      run: (context) => ({ kind: "navigate", href: homeHref(context, path) }),
    });
  }
  if (destination.personal !== undefined) {
    const href = destination.personal;
    definitions.push({
      id,
      kind: "navigate",
      group,
      quick,
      requires: { scope: "personal" },
      run: () => ({ kind: "navigate", href }),
    });
  }
  return definitions;
}

/**
 * Every tool Ora has. The registry filters this list by where the person is and what they may do,
 * so adding a tool here never widens anyone's access: a Home tool names the permission-engine
 * action that allows it, and a tool without a requirement of its own is Personal or any-context.
 * The same id may appear once for Personal and once for a Home (one label, two places).
 */
export const oraToolCatalogue: readonly OraToolDefinition[] = [
  ...destinations.flatMap(toDefinitions),
  {
    id: "capabilities",
    kind: "read",
    group: "ora",
    quick: false,
    requires: { scope: "any" },
    // The registry answers this one with the tools available to the caller.
    run: () => ({ kind: "capabilities", tools: [] }),
  },
];

export function summarise(tool: OraToolDefinition): OraToolSummary {
  return { id: tool.id, kind: tool.kind, group: tool.group, quick: tool.quick };
}
