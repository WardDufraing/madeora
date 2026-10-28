import { readSlotImpact } from "@/meals/data";
import { failure, pathId, readAnswer, readMealQuery } from "@/meals/route-helpers";
import { z } from "zod";

interface ImpactRouteContext {
  readonly params: Promise<{ readonly slotId: string }>;
}

/** What disabling a slot would affect: meals from today, earlier meals and repeating meals. */
export async function GET(request: Request, { params }: ImpactRouteContext): Promise<Response> {
  const query = await readMealQuery(request, z.strictObject({}));
  if (!query.ok) return query.response;
  const slotId = pathId((await params).slotId);
  if (!slotId) return failure(404, "not-found");
  return readAnswer(await readSlotImpact(slotId), "impact");
}
