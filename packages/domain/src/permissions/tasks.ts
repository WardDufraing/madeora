/**
 * Task permissions (S18). Pure and framework-free, like ./home.ts. The database makes the same
 * decisions on every call (`private.can_manage_tasks`, `private.can_edit_task`,
 * `private.can_delete_task` in supabase/migrations/*_tasks.sql); the server and the interface use
 * this module to decide what to offer, never instead of those checks.
 *
 * Default picked in the S18 brief (the per-module permission matrix is open in the spec; the owner
 * may override):
 * - Personal space: its owner does everything; personal tasks have no assignees.
 * - Home: every current member views, creates and comments; a task's creator, its assignees and
 *   task managers edit and complete or reopen it; its creator and task managers delete it; only task
 *   managers set assignees and manage lists and labels. Task managers: the Owner, and Administrators
 *   granted `manageHomeTasks` (`home.tasks.manage`).
 */
import { decideHomeAction, type HomeDecision, type HomeMembershipFacts } from "./home";

export const taskActions = [
  "task.view",
  "task.edit",
  "task.complete",
  "task.assign",
  "task.delete",
  "task.comment",
] as const;
export type TaskAction = (typeof taskActions)[number];

/** Where a task lives, and the acting person's relation to it, as the database reports them now. */
export type TaskFacts =
  | { readonly context: "personal"; readonly ownedByMe: boolean }
  | {
      readonly context: "home";
      readonly homeId: string;
      readonly createdByMe: boolean;
      readonly assignedToMe: boolean;
    };

const allowed: HomeDecision = { allowed: true };
const refused: HomeDecision = { allowed: false, reason: "not-permitted" };

/**
 * Whether the person may perform `action` on the task. For a Home task, `membership` is their
 * current membership of that Home (null: none); a membership of another Home never counts.
 */
export function decideTaskAction(
  task: TaskFacts,
  membership: HomeMembershipFacts | null,
  action: TaskAction,
): HomeDecision {
  if (task.context === "personal") {
    if (!task.ownedByMe) return { allowed: false, reason: "not-member" };
    return action === "task.assign" ? refused : allowed;
  }
  const home = (name: Parameters<typeof decideHomeAction>[2]) =>
    decideHomeAction(task.homeId, membership, name);
  const view = home("home.tasks.view");
  if (!view.allowed) return view;
  const manager = home("home.tasks.manage").allowed;
  switch (action) {
    case "task.view":
      return allowed;
    case "task.comment":
      return home("home.tasks.comment");
    case "task.edit":
    case "task.complete":
      return manager || task.createdByMe || task.assignedToMe ? allowed : refused;
    case "task.assign":
      return manager ? allowed : refused;
    case "task.delete":
      return manager || task.createdByMe ? allowed : refused;
  }
}

export type TaskPermissionProjection = { readonly [A in TaskAction]: boolean };

/** Every task action's answer for one person and task, for the interface. Never authoritative. */
export function taskPermissions(
  task: TaskFacts,
  membership: HomeMembershipFacts | null,
): TaskPermissionProjection {
  const can = (action: TaskAction) => decideTaskAction(task, membership, action).allowed;
  return {
    "task.view": can("task.view"),
    "task.edit": can("task.edit"),
    "task.complete": can("task.complete"),
    "task.assign": can("task.assign"),
    "task.delete": can("task.delete"),
    "task.comment": can("task.comment"),
  };
}
