import { z } from "zod";

import { listTaskAttachments } from "@/tasks/attachment-data";
import { failure, json, requireReader } from "@/tasks/route-helpers";

interface TaskRouteContext {
  readonly params: Promise<{ readonly taskId: string }>;
}

/**
 * A task's attachments (S19c) for someone who may see the task: names, verified types and sizes,
 * whether each came from the series, and what the viewer may do. 404 for a task they cannot see.
 */
export async function GET(_request: Request, { params }: TaskRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const taskId = z.uuid().safeParse((await params).taskId);
  if (!taskId.success) return failure(404, "not-found");
  const read = await listTaskAttachments(taskId.data);
  if (read.status === "not-found") return failure(404, "not-found");
  if (read.status === "unavailable") return failure(500, "failed");
  return json(200, read.value);
}
