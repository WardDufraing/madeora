import { readMealPlan } from "@/meals/data";
import { readAnswer, readMealQuery } from "@/meals/route-helpers";
import { planQuerySchema } from "@/meals/schema";

/**
 * The plan of the Personal space or a Home between two dates (none: today, at most 42 days), read
 * with the person's own session; opening a planner the first time creates its standard slots.
 */
export async function GET(request: Request): Promise<Response> {
  const query = await readMealQuery(request, planQuerySchema);
  if (!query.ok) return query.response;
  const { homeId, from, to } = query.data;
  return readAnswer(await readMealPlan(homeId ?? null, from ?? null, to ?? null), "plan");
}
