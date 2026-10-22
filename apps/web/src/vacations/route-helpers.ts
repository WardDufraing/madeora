import "server-only";

import type { AwayImpact } from "@/chores/api";
import { failure, nullable, outcomeAnswer } from "@/chores/route-helpers";

interface MutationRow {
  readonly outcome: string;
  readonly impact?: unknown;
  readonly revision: number | null;
}

/**
 * The HTTP answer of a vacation or absence change (S22): `200 { outcome, impact, revision }` for
 * `saved`, `preview`, `decided` and the like (`201` when created), else the chore refusal codes. Here
 * `ended` and `cancelled` describe the vacation (`409 vacation-ended`, `409 vacation-cancelled`).
 */
export function vacationAnswer(event: string, row: MutationRow | undefined): Response {
  const revision = row ? nullable(row.revision) : null;
  if (row?.outcome === "ended") {
    return failure(409, "vacation-ended", revision === null ? {} : { revision });
  }
  if (row?.outcome === "cancelled") {
    return failure(409, "vacation-cancelled", revision === null ? {} : { revision });
  }
  const impact = row?.impact ?? null;
  return outcomeAnswer(
    event,
    row?.outcome,
    { outcome: row?.outcome, impact, revision },
    {
      revision,
      ...(row?.outcome === "member_away" && impact !== null
        ? { impact: impact as AwayImpact }
        : {}),
    },
  );
}
