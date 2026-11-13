/** Every Ora tool id; also the message keys of their labels (`Ora.tools.<id>`). Client-safe. */
export const oraToolIds = [
  "open-dashboard",
  "open-tasks",
  "open-chores",
  "open-meals",
  "open-shopping",
  "open-habits",
  "open-goals",
  "open-pets",
  "open-calendar",
  "open-photos",
  "open-members",
  "open-invitations",
  "open-displays",
  "open-home-settings",
  "capabilities",
  "overview",
  "share-overview",
] as const;

export type OraToolId = (typeof oraToolIds)[number];

export function isOraToolId(value: unknown): value is OraToolId {
  return typeof value === "string" && (oraToolIds as readonly string[]).includes(value);
}
