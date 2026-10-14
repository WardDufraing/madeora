// Runs once when the Next.js server starts: fail fast on missing or invalid configuration.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { applyVercelPreviewDefaults } = await import("@madeora/config/env/vercel");
  const { validateStartupEnv } = await import("./env/validate");
  applyVercelPreviewDefaults(process.env);
  validateStartupEnv(process.env);
}
