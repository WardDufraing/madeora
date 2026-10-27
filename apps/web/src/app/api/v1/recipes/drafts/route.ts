import { listMyDrafts } from "@/recipes/data";
import { failure, json, requireReader } from "@/recipes/route-helpers";

/** The signed-in person's own drafts (S24): nobody else's, ever, whatever their role. */
export async function GET(): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const drafts = await listMyDrafts();
  if (drafts.status !== "ok") return failure(500, "failed");
  return json(200, { drafts: drafts.value });
}
