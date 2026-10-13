import type { z } from "zod";

/**
 * Typed, Zod-validated environment configuration (architecture.md §20): the shared parser.
 *
 * Error messages name the variables that failed and why, but never include their values,
 * so a misconfigured secret cannot leak into logs.
 *
 * The schemas live in two separate modules so server secrets cannot reach browser code:
 * - `@madeora/config/env/server`: server-only values. It imports "server-only", so a Client
 *   Component that imports it (directly or through another module) fails the Next.js build.
 * - `@madeora/config/env/public`: `NEXT_PUBLIC_` values, which Next.js bundles into browser code.
 */

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface EnvProblem {
  readonly variable: string;
  readonly reason: "missing" | "invalid";
}

export class EnvValidationError extends Error {
  readonly problems: readonly EnvProblem[];

  constructor(problems: readonly EnvProblem[]) {
    const list = problems.map((p) => `${p.variable} (${p.reason})`).join(", ");
    super(`Invalid environment configuration: ${list}. See apps/web/.env.example.`);
    this.name = "EnvValidationError";
    this.problems = problems;
  }
}

/**
 * Validates the keys of `schema` from `source`. Empty strings count as missing.
 * Only the schema's own keys are read, so unrelated variables are never inspected.
 */
export function parseEnv<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
  source: EnvSource,
): z.infer<z.ZodObject<Shape>> {
  const input: Record<string, string | undefined> = {};
  for (const key of Object.keys(schema.shape)) {
    const value = source[key];
    input[key] = value === "" ? undefined : value;
  }

  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  const problems = new Map<string, EnvProblem>();
  for (const issue of result.error.issues) {
    const variable = String(issue.path[0] ?? "(unknown)");
    if (problems.has(variable)) continue;
    problems.set(variable, {
      variable,
      reason: input[variable] === undefined ? "missing" : "invalid",
    });
  }
  throw new EnvValidationError([...problems.values()]);
}
