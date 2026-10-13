import { z } from "zod";

/**
 * Typed, Zod-validated environment configuration (architecture.md §20).
 *
 * Error messages name the variables that failed and why, but never include their values,
 * so a misconfigured secret cannot leak into logs.
 */

export const appEnvironments = ["development", "test", "preview", "staging", "production"] as const;

/** Server-only settings. Never import a parsed server env into client components. */
export const serverEnvSchema = z.object({
  APP_ENV: z.enum(appEnvironments),
});

/** Public settings. Only `NEXT_PUBLIC_` values belong here; they are bundled into browser code. */
export const publicEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url({ protocol: /^https?$/ }),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type PublicEnv = z.infer<typeof publicEnvSchema>;

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
