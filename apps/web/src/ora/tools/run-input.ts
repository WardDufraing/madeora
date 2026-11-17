import "server-only";

import {
  loadTaskEdit,
  prepareAction,
  prepareTaskAction,
  undoAction,
  undoTaskEdit,
} from "../actions/server";
import { actionInputSchema, isOraActionId, isTaskEditAction } from "../actions/types";
import { loadOverview } from "../overview/server";
import { prepareShare } from "../overview/share-server";
import { overviewRequestSchema, shareRequestSchema } from "../overview/types";
import { findInputTool } from "./registry";
import type { OraToolContext, OraToolResult } from "./types";

/**
 * Runs a tool that takes input (S46). The tool must be available to this person in this place right
 * now (the same check as listing), then its input is validated with its own schema, and only then
 * does it read, always through the person's own session. Unknown, forbidden and other-Home requests
 * are indistinguishable (`forbidden`).
 */
export async function runInputTool(
  context: OraToolContext,
  id: string,
  input: unknown,
): Promise<OraToolResult> {
  const tool = findInputTool(context, id);
  if (!tool) return { status: "forbidden" };

  if (tool.id === "overview") {
    const parsed = overviewRequestSchema.safeParse(input);
    if (!parsed.success) return { status: "invalid" };
    const loaded = await loadOverview(context, parsed.data);
    if (loaded.status !== "ok") return { status: "unavailable" };
    return { status: "ok", output: { kind: "overview", overview: loaded.overview } };
  }

  if (tool.id === "share-overview") {
    const parsed = shareRequestSchema.safeParse(input);
    if (!parsed.success) return { status: "invalid" };
    const prepared = await prepareShare(context, parsed.data);
    if (prepared.status === "invalid") return { status: "invalid" };
    if (prepared.status !== "ok") return { status: "unavailable" };
    return { status: "ok", output: { kind: "share", share: prepared.share } };
  }

  if (isOraActionId(tool.id)) {
    const parsed = actionInputSchema.safeParse(input);
    if (!parsed.success) return { status: "invalid" };
    const request = parsed.data;
    if (isTaskEditAction(tool.id)) {
      if (request.step === "prepare") {
        const prepared = await prepareTaskAction(context, tool.id);
        if (prepared.status !== "ok") return { status: "unavailable" };
        return { status: "ok", output: { kind: "action-tasks", preview: prepared.preview } };
      }
      if (request.step === "task") {
        if (tool.id !== "change-task-due") return { status: "invalid" };
        const loaded = await loadTaskEdit(context, request.id);
        if (loaded.status !== "ok") return { status: "unavailable" };
        return { status: "ok", output: { kind: "action-task", task: loaded.task } };
      }
      if (request.step === "undo-completion" || request.step === "undo-due") {
        const result = await undoTaskEdit(context, tool.id, request);
        if (result === "unavailable") return { status: "unavailable" };
        return { status: "ok", output: { kind: "action-undo", result } };
      }
      return { status: "invalid" };
    }
    if (request.step === "prepare") {
      const prepared = await prepareAction(context, tool.id);
      if (prepared.status !== "ok") return { status: "unavailable" };
      return { status: "ok", output: { kind: "action-preview", preview: prepared.preview } };
    }
    if (request.step === "undo") {
      const result = await undoAction(context, tool.id, request);
      if (result === "unavailable") return { status: "unavailable" };
      return { status: "ok", output: { kind: "action-undo", result } };
    }
    return { status: "invalid" };
  }

  return { status: "forbidden" };
}
