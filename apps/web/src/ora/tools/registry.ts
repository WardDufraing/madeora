import { decideHomeAction } from "@madeora/domain/permissions";

import { oraToolCatalogue, summarise } from "./catalogue";
import type { OraToolContext, OraToolDefinition, OraToolResult, OraToolSummary } from "./types";

/**
 * Whether the person may use a tool right now, where they are. The answer comes from the
 * permission engine (`decideHomeAction`) for Home tools and from the place alone for the rest; it
 * never comes from the tool's own code or from anything the browser sent.
 */
function isAvailable(tool: OraToolDefinition, context: OraToolContext): boolean {
  const { requires } = tool;
  switch (requires.scope) {
    case "any":
      return true;
    case "personal":
      return context.home === null;
    case "home":
      return (
        context.home !== null &&
        decideHomeAction(context.home.id, context.home.membership, requires.action).allowed
      );
  }
}

/** The tools Ora may offer or run for this person here, in catalogue order. */
export function availableTools(context: OraToolContext): readonly OraToolSummary[] {
  return oraToolCatalogue.filter((tool) => isAvailable(tool, context)).map(summarise);
}

/**
 * Runs one tool by id. The tool must be available to this person in this place at this moment;
 * anything else (an id that does not exist, a Home tool in Personal, a tool the role lacks, a
 * tool of a Home the person does not belong to) returns the same `forbidden`, so the answer never
 * reveals what exists.
 */
export function runTool(context: OraToolContext, id: string): OraToolResult {
  const tool = oraToolCatalogue.find(
    (candidate) => candidate.id === id && isAvailable(candidate, context),
  );
  if (!tool) return { status: "forbidden" };
  if (tool.id === "capabilities") {
    return { status: "ok", output: { kind: "capabilities", tools: availableTools(context) } };
  }
  return { status: "ok", output: tool.run(context) };
}
